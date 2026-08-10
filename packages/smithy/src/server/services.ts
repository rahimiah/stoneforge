/**
 * Service Initialization
 *
 * Creates and exports all orchestrator services.
 */

import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, createInboxService, createSyncService, createAutoExportService, loadConfig } from '@stoneforge/quarry';
import type { QuarryAPI, InboxService, SyncService, AutoExportService } from '@stoneforge/quarry';
import { createSessionMessageService, type SessionMessageService } from './services/session-messages.js';
import { TaskStatus, type EntityId, type ElementId, type Playbook, type Task } from '@stoneforge/core';
import {
  createOrchestratorAPI,
  createAgentRegistry,
  createSessionManager,
  createSpawnerService,
  createWorktreeManager,
  createTaskAssignmentService,
  createDispatchService,
  createRoleDefinitionService,
  createWorkerTaskService,
  createStewardScheduler,
  createStewardExecutor,
  createPluginExecutor,
  createDispatchDaemon,
  createAgentPoolService,
  createMergeStewardService,
  createGitHubMergeProvider,
  createDocsStewardService,
  createSettingsService,
  createMetricsService,
  createRateLimitTracker,
  createExternalSyncDaemon,
  GitRepositoryNotFoundError,
  type OrchestratorAPI,
  type AgentRegistry,
  type SessionManager,
  type SpawnerService,
  type WorktreeManager,
  type TaskAssignmentService,
  type DispatchService,
  type RoleDefinitionService,
  type WorkerTaskService,
  type StewardScheduler,
  type PluginExecutor,
  type DispatchDaemon,
  type AgentPoolService,
  type MergeStewardService,
  type DocsStewardService,
  type SettingsService,
  type MetricsService,
  type MetricOutcome,
  type OnSessionStartedCallback,
  type ExternalSyncDaemon,
  type SpawnedSessionEvent,
  getAgentMetadata,
  trackListeners,
} from '../index.js';
import { createSyncEngine, createDefaultProviderRegistry } from '@stoneforge/quarry';
import { attachSessionEventSaver } from './routes/sessions.js';
import { notifySSEClientsOfNewSession } from './routes/events.js';
import { DB_PATH as DEFAULT_DB_PATH, PROJECT_ROOT as DEFAULT_PROJECT_ROOT, getClaudePath } from './config.js';
import { getDaemonConfigOverrides } from './daemon-state.js';
import { createLogger } from '../utils/logger.js';
import { getFallbackResetTime } from '../utils/rate-limit-parser.js';

const logger = createLogger('orchestrator');

export interface ServicesOptions {
  dbPath?: string;
  projectRoot?: string;
}

export interface Services {
  api: QuarryAPI;
  orchestratorApi: OrchestratorAPI;
  agentRegistry: AgentRegistry;
  sessionManager: SessionManager;
  spawnerService: SpawnerService;
  worktreeManager: WorktreeManager | undefined;
  taskAssignmentService: TaskAssignmentService;
  dispatchService: DispatchService;
  roleDefinitionService: RoleDefinitionService;
  workerTaskService: WorkerTaskService;
  stewardScheduler: StewardScheduler;
  pluginExecutor: PluginExecutor;
  poolService: AgentPoolService | undefined;
  inboxService: InboxService;
  syncService: SyncService;
  autoExportService: AutoExportService;
  mergeStewardService: MergeStewardService;
  docsStewardService: DocsStewardService;
  dispatchDaemon: DispatchDaemon | undefined;
  externalSyncDaemon: ExternalSyncDaemon | undefined;
  sessionInitialPrompts: Map<string, string>;
  sessionMessageService: SessionMessageService;
  settingsService: SettingsService;
  metricsService: MetricsService;
  storageBackend: StorageBackend;
}

export interface MetricTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CodexSessionMetrics extends MetricTokenUsage {
  model?: string;
  modelProvider?: string;
}

export interface CodexSessionReadOptions {
  sessionsRoot?: string;
  now?: Date;
}

export const CODEX_SESSION_TAIL_BYTES = 256 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractTokenUsage(value: unknown): MetricTokenUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const directInputTokens = asNumber(record.input_tokens ?? record.inputTokens);
  const directOutputTokens = asNumber(record.output_tokens ?? record.outputTokens);
  if (directInputTokens !== undefined || directOutputTokens !== undefined) {
    return {
      inputTokens: directInputTokens ?? 0,
      outputTokens: directOutputTokens ?? 0,
    };
  }

  return (
    extractTokenUsage(record.total) ??
    extractTokenUsage(record.total_token_usage) ??
    extractTokenUsage(record.last) ??
    extractTokenUsage(record.last_token_usage) ??
    extractTokenUsage(record.info) ??
    extractTokenUsage(record.usage) ??
    extractTokenUsage(record.tokenUsage) ??
    extractTokenUsage(asRecord(record.params)?.tokenUsage) ??
    extractTokenUsage(asRecord(record.payload)?.info)
  );
}

export function accumulateMetricTokenUsage(
  current: MetricTokenUsage,
  raw: unknown
): MetricTokenUsage {
  const usage = extractTokenUsage(raw);
  if (!usage) {
    return current;
  }

  return {
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
  };
}

/** Token usage attributed to a specific assistant message. */
export interface MetricMessageTokenUsage extends MetricTokenUsage {
  messageId: string;
}

/**
 * Extract per-message token usage from an OpenCode `message.updated` event.
 *
 * OpenCode reports usage as `properties.info.tokens = { input, output, ... }` on
 * an assistant message — a shape `extractTokenUsage` does not recognise, which is
 * why OpenCode sessions recorded zero tokens while their model was captured fine.
 *
 * Crucially these events are CUMULATIVE PER MESSAGE: `message.updated` fires
 * repeatedly for the same message id as the reply streams, each time carrying the
 * running total for that message. Summing every event would multiply the real
 * usage many times over, so callers must keep the LAST value seen per message id
 * and add up across distinct ids. That is why this returns the id rather than a
 * bare total.
 */
export function extractMessageTokenUsage(raw: unknown): MetricMessageTokenUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const info = asRecord(asRecord(record.properties)?.info) ?? asRecord(record.info);
  if (!info) return undefined;

  // Only assistant messages carry usage; user messages have no `tokens`.
  const tokens = asRecord(info.tokens);
  if (!tokens) return undefined;

  const messageId = asString(info.id);
  if (!messageId) return undefined;

  const inputTokens = asNumber(tokens.input);
  const outputTokens = asNumber(tokens.output);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  return {
    messageId,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
}

/**
 * Total the per-message usage collected during a session.
 */
export function totalMessageTokenUsage(
  perMessage: ReadonlyMap<string, MetricTokenUsage>
): MetricTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of perMessage.values()) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return { inputTokens, outputTokens };
}

export function extractMetricModel(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const directModel = asString(record.model ?? record.modelID ?? record.model_id);
  if (directModel) {
    const providerId = asString(record.providerID ?? record.provider_id);
    return providerId && !directModel.includes('/')
      ? `${providerId}/${directModel}`
      : directModel;
  }

  const modelRecord = asRecord(record.model);
  const modelId = asString(modelRecord?.modelID ?? modelRecord?.model_id ?? modelRecord?.id);
  if (modelId) {
    const providerId = asString(modelRecord?.providerID ?? modelRecord?.provider_id);
    return providerId && !modelId.includes('/') ? `${providerId}/${modelId}` : modelId;
  }

  const modelUsage = asRecord(record.modelUsage ?? record.model_usage);
  if (modelUsage) {
    const [model] = Object.keys(modelUsage);
    if (model) return model;
  }

  return (
    extractMetricModel(record.message) ??
    extractMetricModel(record.info) ??
    extractMetricModel(record.properties) ??
    extractMetricModel(record.payload)
  );
}

export function extractCodexSessionMetrics(content: string): CodexSessionMetrics | undefined {
  let model: string | undefined;
  let modelProvider: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawMetrics = false;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) continue;

    if (entry.type === 'session_meta') {
      const payload = asRecord(entry.payload);
      modelProvider = asString(payload?.model_provider) ?? modelProvider;
      continue;
    }

    if (entry.type === 'turn_context') {
      const payload = asRecord(entry.payload);
      model = asString(payload?.model) ?? model;
      continue;
    }

    if (entry.type !== 'event_msg') {
      continue;
    }

    const payload = asRecord(entry.payload);
    if (payload?.type !== 'token_count') {
      continue;
    }

    const usage = extractTokenUsage(payload);
    if (!usage) {
      continue;
    }

    inputTokens = usage.inputTokens;
    outputTokens = usage.outputTokens;
    sawMetrics = true;
  }

  if (!model && !modelProvider && !sawMetrics) {
    return undefined;
  }

  return {
    model,
    modelProvider,
    inputTokens,
    outputTokens,
  };
}

function codexSessionDateDirectories(sessionsRoot: string, now: Date): string[] {
  return [0, 1].map((daysAgo) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    return join(
      sessionsRoot,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    );
  });
}

export async function findCodexSessionFile(
  providerSessionId: string,
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
  now = new Date()
): Promise<string | undefined> {
  for (const dateDirectory of codexSessionDateDirectories(sessionsRoot, now)) {
    try {
      const entries = await readdir(dateDirectory, {
        withFileTypes: true,
        encoding: 'utf8',
      });

      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`-${providerSessionId}.jsonl`)
        ) {
          return join(dateDirectory, entry.name);
        }
      }
    } catch {
      // Missing or unreadable date directories simply mean there is no matching session here.
    }
  }

  return undefined;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const file = await open(filePath, 'r');

  try {
    const { size } = await file.stat();
    const bytesToRead = Math.min(size, maxBytes);
    if (bytesToRead === 0) {
      return '';
    }

    const buffer = Buffer.allocUnsafe(bytesToRead);
    const startPosition = size - bytesToRead;
    let totalBytesRead = 0;

    while (totalBytesRead < bytesToRead) {
      const { bytesRead } = await file.read(
        buffer,
        totalBytesRead,
        bytesToRead - totalBytesRead,
        startPosition + totalBytesRead
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }

    return buffer.subarray(0, totalBytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function readCodexSessionMetrics(
  provider: string | undefined,
  providerSessionId: string | undefined,
  options: CodexSessionReadOptions = {}
): Promise<CodexSessionMetrics | undefined> {
  if (provider !== 'codex' || !providerSessionId) {
    return undefined;
  }

  const sessionFile = await findCodexSessionFile(
    providerSessionId,
    options.sessionsRoot,
    options.now
  );
  if (!sessionFile) {
    return undefined;
  }

  try {
    const metrics = extractCodexSessionMetrics(
      await readFileTail(sessionFile, CODEX_SESSION_TAIL_BYTES)
    );
    if (!metrics?.model && !metrics?.inputTokens && !metrics?.outputTokens) {
      logger.warn(
        `Codex session metrics file ${sessionFile} contained no usable model or token data`
      );
      return undefined;
    }

    return metrics;
  } catch (error) {
    logger.warn(`Failed to read Codex session metrics file ${sessionFile}`, error);
    return undefined;
  }
}

function isFailedResultEvent(event: SpawnedSessionEvent): boolean {
  if (typeof event.subtype === 'string' && event.subtype.startsWith('error')) {
    return true;
  }

  const raw = asRecord(event.raw);
  if (!raw) {
    return false;
  }

  if (raw.is_error === true) {
    return true;
  }

  const rawTurn = asRecord(asRecord(raw.params)?.turn);
  return rawTurn?.status === 'failed';
}

export function deriveMetricOutcome(
  taskStatus: Task['status'] | undefined,
  sessionOutcome: MetricOutcome
): MetricOutcome {
  if (sessionOutcome === 'failed' || sessionOutcome === 'rate_limited') {
    return sessionOutcome;
  }

  if (taskStatus === TaskStatus.OPEN || taskStatus === TaskStatus.DEFERRED) {
    return 'handoff';
  }

  return sessionOutcome;
}

export async function initializeServices(options: ServicesOptions = {}): Promise<Services> {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;

  if (dbPath !== ':memory:') {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const storageBackend = createStorage({ path: dbPath });
  initializeSchema(storageBackend);

  const api = createQuarryAPI(storageBackend);
  const orchestratorApi = createOrchestratorAPI(storageBackend);
  const agentRegistry = createAgentRegistry(api);
  const config = loadConfig();

  const claudePath = getClaudePath();
  logger.info(`Using Claude CLI at: ${claudePath}`);

  const spawnerService = createSpawnerService({
    workingDirectory: projectRoot,
    stoneforgeRoot: projectRoot,
    claudePath,
  });

  // Create settings service early so it can be injected into session manager
  const settingsService = createSettingsService(storageBackend);

  // Create metrics service for provider usage tracking
  const metricsService = createMetricsService(storageBackend);

  const sessionManager = createSessionManager(spawnerService, api, agentRegistry, settingsService);
  const sessionInitialPrompts = new Map<string, string>();

  // Load session state for all agents to restore session history after restart
  const agents = await agentRegistry.listAgents();
  for (const agent of agents) {
    try {
      await sessionManager.loadSessionState(agent.id as unknown as EntityId);
    } catch (err) {
      logger.warn(`Failed to load session state for agent ${agent.name}:`, err);
    }
  }
  logger.info(`Loaded session state for ${agents.length} agents`);

  const taskAssignmentService = createTaskAssignmentService(api);
  const dispatchService = createDispatchService(api, taskAssignmentService, agentRegistry);
  const roleDefinitionService = createRoleDefinitionService(api);

  let worktreeManager: WorktreeManager | undefined;
  try {
    worktreeManager = createWorktreeManager({ workspaceRoot: projectRoot });
    // Initialize the worktree manager (creates .stoneforge/.worktrees directory, validates git repo)
    // This is synchronous initialization - consider making services async if this becomes slow
    await worktreeManager.initWorkspace();
  } catch (err) {
    if (err instanceof GitRepositoryNotFoundError) {
      logger.warn('Git repository not found - worktree features disabled');
      worktreeManager = undefined;
    } else {
      throw err;
    }
  }

  const workerTaskService = createWorkerTaskService(
    api,
    taskAssignmentService,
    agentRegistry,
    dispatchService,
    spawnerService,
    sessionManager,
    worktreeManager
  );

  let githubMergeProvider: ReturnType<typeof createGitHubMergeProvider> | undefined;
  if (config.merge.provider === 'github-pr') {
    githubMergeProvider = createGitHubMergeProvider();
    try {
      await githubMergeProvider.assertCliReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub PR merge provider startup validation failed: ${message}`);
    }
  }

  // Create steward services (before executor/scheduler so they can be passed to the executor)
  const mergeStewardService = createMergeStewardService(
    api,
    taskAssignmentService,
    dispatchService,
    agentRegistry,
    {
      workspaceRoot: projectRoot,
      mergeProvider: config.merge.provider,
      ciTimeoutMinutes: config.merge.ciTimeoutMinutes,
      requiredChecks: config.merge.requiredChecks,
      deleteBranchAfterMerge: config.merge.deleteBranchOnMerge,
    },
    worktreeManager,
    undefined,
    githubMergeProvider
  );

  const docsStewardService = createDocsStewardService({
    workspaceRoot: projectRoot,
  });

  const rateLimitTracker = createRateLimitTracker();

  const stewardExecutor = createStewardExecutor({
    mergeStewardService,
    docsStewardService,
    sessionManager,
    projectRoot,
    rateLimitTracker,
    settingsService,
    resolvePlaybookContent: async (playbookId: string): Promise<string | undefined> => {
      const playbook = await api.get<Playbook>(playbookId as ElementId);
      if (!playbook) return undefined;

      // Convert playbook steps into a markdown description for the steward prompt
      const parts: string[] = [];
      if (playbook.title) {
        parts.push(`# ${playbook.title}`);
      }
      if (playbook.steps && playbook.steps.length > 0) {
        parts.push('\n## Steps\n');
        for (const step of playbook.steps) {
          parts.push(`### ${step.title}`);
          if (step.description) {
            parts.push(step.description);
          }
          if (step.dependsOn && step.dependsOn.length > 0) {
            parts.push(`_Depends on: ${step.dependsOn.join(', ')}_`);
          }
          parts.push('');
        }
      }
      return parts.join('\n') || playbook.title || undefined;
    },
  });
  const stewardScheduler = createStewardScheduler(agentRegistry, stewardExecutor, {
    maxHistoryPerSteward: 100,
    defaultTimeoutMs: 5 * 60 * 1000,
    startImmediately: false,
  });

  const pluginExecutor = createPluginExecutor({
    api,
    workspaceRoot: projectRoot,
  });

  // Create pool service for agent concurrency limiting
  const poolService = createAgentPoolService(api, sessionManager, agentRegistry);

  const inboxService = createInboxService(storageBackend);
  const sessionMessageService = createSessionMessageService(storageBackend);

  // Create sync and auto-export services
  const { resolve } = await import('node:path');
  const syncService = createSyncService(storageBackend);
  const autoExportService = createAutoExportService({
    syncService,
    backend: storageBackend,
    syncConfig: config.sync,
    outputDir: resolve(projectRoot, '.stoneforge/sync'),
  });
  autoExportService.start().catch((err: Error) => {
    logger.error('Failed to start auto-export:', err);
  });

  // DispatchDaemon requires worktreeManager, so only create if available
  let dispatchDaemon: DispatchDaemon | undefined;
  if (worktreeManager) {
    // Callback to attach event saver and save initial prompt when daemon starts a session
    const onSessionStarted: OnSessionStartedCallback = (session, events, agentId, initialPrompt) => {
      // Attach event saver to capture all agent events
      attachSessionEventSaver(events, session.id, agentId, sessionMessageService);

      // Notify SSE stream clients so they dynamically subscribe to this session's events
      notifySSEClientsOfNewSession({
        sessionId: session.id,
        agentId: agentId as EntityId,
        agentRole: session.agentRole || 'worker',
        events,
      });

      // Store initial prompt for SSE clients
      sessionInitialPrompts.set(session.id, initialPrompt);

      // Save initial prompt to database
      const initialMsgId = `user-${session.id}-initial`;
      sessionMessageService.saveMessage({
        id: initialMsgId,
        sessionId: session.id,
        agentId: agentId as EntityId,
        type: 'user',
        content: initialPrompt,
        isError: false,
      });

      // Track metrics state for this session
      const sessionStartTime = Date.now();
      let metricsRecorded = false;
      let sessionOutcome: MetricOutcome = 'completed';
      let sessionInputTokens = 0;
      let sessionOutputTokens = 0;
      let sessionModel: string | undefined;
      // Per-assistant-message usage, for providers (OpenCode) that report a
      // running cumulative total per message rather than a one-shot session total.
      const sessionMessageTokens = new Map<string, MetricTokenUsage>();

      // Listen for rate_limited events from sessions and forward to trackers
      const onRateLimited = (data: { executablePath?: string; resetsAt?: Date; message?: string }) => {
        if (data.executablePath) {
          const resetTime = data.resetsAt ?? getFallbackResetTime(data.message ?? '');
          // Forward to dispatch daemon's internal tracker
          if (dispatchDaemon) {
            dispatchDaemon.handleRateLimitDetected(data.executablePath, resetTime);
          }
          // Forward to steward executor's tracker
          rateLimitTracker.markLimited(data.executablePath, resetTime);
        }
        sessionOutcome = 'rate_limited';
      };

      const sessionAgentMetaPromise = agentRegistry.getAgent(agentId)
        .then(agent => agent ? getAgentMetadata(agent) : undefined)
        .catch(() => undefined);
      // Capture the task assignment at session start, before dispatch/unassign transitions on exit.
      const sessionTaskIdPromise = taskAssignmentService.getAgentTasks(agentId)
        .then(tasks => tasks.length > 0 ? tasks[0].taskId : undefined)
        .catch(() => undefined);

      // Helper to record metrics once on session completion
      const recordSessionMetrics = async () => {
        if (metricsRecorded) return;
        metricsRecorded = true;

        const durationMs = Date.now() - sessionStartTime;
        const [taskId, agentMeta] = await Promise.all([
          sessionTaskIdPromise,
          sessionAgentMetaPromise,
        ]);
        const provider = asString(agentMeta?.provider) ?? 'claude-code';
        const codexSessionMetrics = await readCodexSessionMetrics(
          provider,
          session.providerSessionId
        );
        const model =
          sessionModel ??
          codexSessionMetrics?.model ??
          asString(agentMeta?.model);

        if (codexSessionMetrics && (codexSessionMetrics.inputTokens > 0 || codexSessionMetrics.outputTokens > 0)) {
          sessionInputTokens = codexSessionMetrics.inputTokens;
          sessionOutputTokens = codexSessionMetrics.outputTokens;
        } else if (sessionMessageTokens.size > 0) {
          // Providers reporting cumulative per-message usage (OpenCode): sum the
          // last value seen for each distinct message.
          const totals = totalMessageTokenUsage(sessionMessageTokens);
          sessionInputTokens = totals.inputTokens;
          sessionOutputTokens = totals.outputTokens;
        }

        const task = taskId
          ? await api.get<Task>(taskId as ElementId).catch(() => undefined)
          : undefined;

        metricsService.record({
          provider,
          model,
          sessionId: session.id,
          taskId,
          inputTokens: sessionInputTokens,
          outputTokens: sessionOutputTokens,
          durationMs,
          outcome: deriveMetricOutcome(task?.status, sessionOutcome),
        });
      };

      // Auto-terminate sessions when they emit a 'result' event
      // This handles ephemeral worker sessions completing their tasks
      const onSessionEvent = (event: SpawnedSessionEvent) => {
        sessionModel = extractMetricModel(event.raw) ?? sessionModel;

        // Two disjoint token sources. OpenCode reports cumulative usage per
        // assistant message, so those are keyed by message id and last-write-wins;
        // Claude and Codex report one-shot totals, which accumulate additively.
        // A given event matches at most one shape, so there is no double counting.
        const messageUsage = extractMessageTokenUsage(event.raw);
        if (messageUsage) {
          sessionMessageTokens.set(messageUsage.messageId, {
            inputTokens: messageUsage.inputTokens,
            outputTokens: messageUsage.outputTokens,
          });
        } else {
          const totals = accumulateMetricTokenUsage({
            inputTokens: sessionInputTokens,
            outputTokens: sessionOutputTokens,
          }, event.raw);
          sessionInputTokens = totals.inputTokens;
          sessionOutputTokens = totals.outputTokens;
        }

        if (event.type === 'error') {
          if (sessionOutcome !== 'rate_limited') {
            sessionOutcome = 'failed';
          }
          return;
        }

        if (event.type === 'result') {
          if (isFailedResultEvent(event) && sessionOutcome !== 'rate_limited') {
            sessionOutcome = 'failed';
          }
          void recordSessionMetrics();

          logger.debug(`Session ${session.id} emitted result, auto-terminating`);
          sessionManager.stopSession(session.id, {
            graceful: true,
            reason: 'Completed with result',
          }).catch(() => {
            // Session may already be terminated - ignore errors
          });
          cleanup();
        }
      };

      // Clean up onResultEvent listener on session exit to prevent leaks
      // This handles sessions that terminate without emitting a 'result' event
      const onExit = (code?: number) => {
        // If metrics haven't been recorded yet (no result event), record on exit
        if (!metricsRecorded) {
          if (code && code !== 0 && sessionOutcome === 'completed') {
            sessionOutcome = 'failed';
          }
          void recordSessionMetrics();
        }
        cleanup();
      };

      const cleanup = trackListeners(events, {
        'rate_limited': onRateLimited,
        'event': onSessionEvent,
        'exit': onExit,
      });
    };

    const configOverrides = getDaemonConfigOverrides();
    dispatchDaemon = createDispatchDaemon(
      api,
      agentRegistry,
      sessionManager,
      dispatchService,
      worktreeManager,
      taskAssignmentService,
      stewardScheduler,
      inboxService,
      { pollIntervalMs: 5000, onSessionStarted, ...configOverrides },
      poolService,
      settingsService
    );
  } else {
    logger.warn('DispatchDaemon disabled - no git repository');
  }

  // ExternalSyncDaemon — only instantiate when external sync is enabled
  // AND at least one provider has a configured token.
  // Zero-overhead guarantee: unconfigured workspaces pay no cost.
  let externalSyncDaemon: ExternalSyncDaemon | undefined;
  if (config.externalSync.enabled) {
    const externalSyncSettings = settingsService.getExternalSyncSettings();
    const hasConfiguredProvider = Object.values(externalSyncSettings.providers).some(
      (p) => p.token != null && p.token.length > 0
    );

    if (hasConfiguredProvider) {
      const registry = createDefaultProviderRegistry();
      const syncEngine = createSyncEngine({
        api,
        registry,
        settings: settingsService,
        providerConfigs: Object.values(externalSyncSettings.providers),
      });
      externalSyncDaemon = createExternalSyncDaemon(syncEngine, {
        pollIntervalMs: externalSyncSettings.pollIntervalMs ?? config.externalSync.pollInterval,
      });
      logger.info('External sync daemon created (will start when server starts)');
    } else {
      logger.info('External sync enabled but no providers configured with tokens — daemon not created');
    }
  }

  logger.info(`Connected to database: ${dbPath}`);

  return {
    api,
    orchestratorApi,
    agentRegistry,
    sessionManager,
    spawnerService,
    worktreeManager,
    taskAssignmentService,
    dispatchService,
    roleDefinitionService,
    workerTaskService,
    mergeStewardService,
    docsStewardService,
    stewardScheduler,
    pluginExecutor,
    poolService,
    inboxService,
    syncService,
    autoExportService,
    dispatchDaemon,
    externalSyncDaemon,
    sessionInitialPrompts,
    sessionMessageService,
    settingsService,
    metricsService,
    storageBackend,
  };
}
