/**
 * Service Initialization
 *
 * Creates and exports all orchestrator services.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export function extractClaudeSessionMetrics(
  content: string,
  startedAtMs?: number
): Omit<CodexSessionMetrics, 'modelProvider'> | undefined {
  let model: string | undefined;
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

    const entryTimestamp = asString(entry.timestamp);
    if (startedAtMs !== undefined && entryTimestamp) {
      const entryTimeMs = Date.parse(entryTimestamp);
      if (Number.isFinite(entryTimeMs) && entryTimeMs < startedAtMs) {
        continue;
      }
    }

    const message = asRecord(entry.message);
    model = extractMetricModel(message) ?? model;

    const usage = extractTokenUsage(message?.usage);
    if (!usage) continue;

    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    sawMetrics = true;
  }

  if (!model && !sawMetrics) {
    return undefined;
  }

  return { model, inputTokens, outputTokens };
}

function findCodexSessionFile(
  providerSessionId: string,
  sessionsRoot = join(homedir(), '.codex', 'sessions')
): string | undefined {
  if (!existsSync(sessionsRoot)) {
    return undefined;
  }

  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) continue;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(currentDir, {
        withFileTypes: true,
        encoding: 'utf8',
      }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(`${providerSessionId}.jsonl`)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function readCodexSessionMetrics(providerSessionId?: string): CodexSessionMetrics | undefined {
  if (!providerSessionId) {
    return undefined;
  }

  const sessionFile = findCodexSessionFile(providerSessionId);
  if (!sessionFile) {
    return undefined;
  }

  try {
    return extractCodexSessionMetrics(readFileSync(sessionFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function readClaudeSessionMetrics(
  providerSessionId: string | undefined,
  workingDirectory: string,
  startedAtMs: number
): Omit<CodexSessionMetrics, 'modelProvider'> | undefined {
  if (!providerSessionId) {
    return undefined;
  }

  const projectDirectory = workingDirectory.replace(/[^a-zA-Z0-9-]/g, '-');
  const sessionFile = join(
    homedir(),
    '.claude',
    'projects',
    projectDirectory,
    `${providerSessionId}.jsonl`
  );
  if (!existsSync(sessionFile)) {
    return undefined;
  }

  try {
    return extractClaudeSessionMetrics(readFileSync(sessionFile, 'utf8'), startedAtMs);
  } catch {
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
      const sessionMetricsStartTime = session.startedAt
        ? new Date(session.startedAt).getTime()
        : sessionStartTime;
      let metricsRecorded = false;
      let sessionOutcome: MetricOutcome = 'completed';
      let sessionInputTokens = 0;
      let sessionOutputTokens = 0;
      let sessionModel: string | undefined;
      let sessionProviderSessionId = session.providerSessionId;

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
        const sessionFileMetrics = provider === 'codex'
          ? readCodexSessionMetrics(sessionProviderSessionId)
          : provider === 'claude-code' || provider === 'claude'
            ? readClaudeSessionMetrics(
                sessionProviderSessionId,
                session.workingDirectory,
                sessionMetricsStartTime
              )
            : undefined;
        const model =
          sessionModel ??
          sessionFileMetrics?.model ??
          asString(agentMeta?.model);

        if (sessionFileMetrics && (sessionFileMetrics.inputTokens > 0 || sessionFileMetrics.outputTokens > 0)) {
          sessionInputTokens = sessionFileMetrics.inputTokens;
          sessionOutputTokens = sessionFileMetrics.outputTokens;
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
        const raw = asRecord(event.raw);
        sessionProviderSessionId = asString(raw?.session_id) ?? sessionProviderSessionId;
        sessionModel = extractMetricModel(event.raw) ?? sessionModel;

        const totals = accumulateMetricTokenUsage({
          inputTokens: sessionInputTokens,
          outputTokens: sessionOutputTokens,
        }, event.raw);
        sessionInputTokens = totals.inputTokens;
        sessionOutputTokens = totals.outputTokens;

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
