/**
 * OpenCode Server Manager (Singleton)
 *
 * Manages the lifecycle of a single shared OpenCode server process.
 * Multiple sessions share one server; ref counting shuts it down
 * when the last session releases.
 *
 * @module
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __opencodeFilename = fileURLToPath(import.meta.url);
const __opencodeDir = dirname(__opencodeFilename);

/**
 * Directory holding the `sf` CLI binary, resolved from this module's own location
 * (dist/providers/opencode/) rather than from stoneforgeRoot, which points at the
 * managed project instead of the sf installation.
 */
export const SF_BIN_DIR = resolve(__opencodeDir, '../../bin');

/**
 * Configure the environment the OpenCode server will be spawned with.
 *
 * Mutates `process.env` deliberately. The OpenCode SDK spawns its server with
 * `env: { ...process.env }` and exposes no per-spawn env option, so this is the
 * only channel that reaches the child process. Safe to call repeatedly: the PATH
 * entry is only prepended when absent.
 *
 * Without SF_BIN_DIR on PATH, agents cannot run `sf task complete` or
 * `sf task handoff`, which the worker prompt requires to end a session. They then
 * stall and get resumed indefinitely.
 */
export function applyOpenCodeEnv(stoneforgeRoot?: string): void {
  process.env.OPENCODE_PERMISSION = JSON.stringify({ '*': 'allow' });
  process.env.OPENCODE_CLIENT = 'stoneforge';
  if (stoneforgeRoot) {
    process.env.STONEFORGE_ROOT = stoneforgeRoot;
  }
  // The `sf` launcher runs sf.js under this interpreter. Without it, sf inherits
  // whatever Node the agent's login shell resolves, which is often outside the
  // supported range (>=18 <25) and breaks every `sf task complete`.
  process.env.STONEFORGE_NODE = process.execPath;

  const currentPath = process.env.PATH ?? '';
  if (!currentPath.split(':').includes(SF_BIN_DIR)) {
    process.env.PATH = currentPath ? `${SF_BIN_DIR}:${currentPath}` : SF_BIN_DIR;
  }
}

// ============================================================================
// Internal Types (our interface into the SDK)
// ============================================================================

/** Session object from the SDK */
export interface OpencodeSession {
  id: string;
  projectID?: string;
  directory?: string;
}

/** SDK response wrapper — all SDK methods return { data, error, request, response } */
export interface SdkResponse<T> {
  data: T | undefined;
  error?: unknown;
}

/** SSE subscribe result — returns { stream: AsyncGenerator<Event> } */
export interface SseSubscribeResult {
  stream: AsyncIterable<unknown>;
}

/** Text part input for prompts */
export interface TextPartInput {
  type: 'text';
  text: string;
}

/** Model information from OpenCode SDK */
export interface OpencodeModel {
  id: string;
  providerID?: string;
  name: string;
}

/** Provider information from OpenCode SDK (config.providers) */
export interface OpencodeProvider {
  id: string;
  name: string;
  models: Record<string, OpencodeModel>;
}

/** Response from config.providers() */
export interface ConfigProvidersResponse {
  providers: OpencodeProvider[];
  default: Record<string, string>;
}

/** Provider entry from provider.list() — includes all available providers */
export interface OpencodeProviderListItem {
  id: string;
  name: string;
  models: Record<string, OpencodeModel>;
}

/** Response from provider.list() */
export interface ProviderListResponse {
  all: OpencodeProviderListItem[];
  default: Record<string, string>;
  connected: string[];
}

/** Model specification for promptAsync */
export interface ModelSpec {
  providerID: string;
  modelID: string;
}

/** Minimal OpenCode client shape matching the real SDK response wrappers */
export interface OpencodeClient {
  session: {
    create(opts: { body: { title?: string } }): Promise<SdkResponse<OpencodeSession>>;
    get(opts: { path: { id: string } }): Promise<SdkResponse<OpencodeSession>>;
    abort(opts: { path: { id: string } }): Promise<SdkResponse<unknown>>;
    promptAsync(opts: {
      path: { id: string };
      body: { parts: TextPartInput[]; model?: ModelSpec };
    }): Promise<SdkResponse<void>>;
  };
  event: {
    subscribe(): Promise<SseSubscribeResult>;
  };
  config: {
    providers(): Promise<SdkResponse<ConfigProvidersResponse>>;
  };
  provider: {
    list(): Promise<SdkResponse<ProviderListResponse>>;
  };
}

/** Minimal OpenCode server shape */
interface OpencodeServer {
  close(): void;
}

// ============================================================================
// Server Manager
// ============================================================================

/** Default model for OpenCode provider */
const OPENCODE_DEFAULT_MODEL = 'opencode/minimax-m2.5-free';

export interface ServerManagerConfig {
  port?: number;
  /**
   * Retained for call-site compatibility but NOT used to start the server: the
   * SDK provides no way to set the server's working directory, and one shared
   * server serves every session. Sessions carry their own directory per request.
   */
  cwd?: string;
  stoneforgeRoot?: string;
}

/**
 * Manages a single shared OpenCode server instance.
 *
 * - `acquire()` starts or reuses the server, increments ref count
 * - `release()` decrements ref count, stops server at zero
 * - Concurrent acquire() calls are coalesced into a single startup
 */
class OpenCodeServerManager {
  private client: OpencodeClient | null = null;
  private server: OpencodeServer | null = null;
  private refCount = 0;
  private startPromise: Promise<OpencodeClient> | null = null;

  async acquire(config?: ServerManagerConfig): Promise<OpencodeClient> {
    this.refCount++;

    if (this.client) {
      return this.client;
    }

    // Coalesce concurrent startup requests
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startServer(config);

    try {
      const client = await this.startPromise;
      return client;
    } catch (error) {
      this.refCount--;
      this.startPromise = null;
      throw error;
    }
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) {
      this.shutdown();
    }
  }

  shutdown(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.client = null;
    this.startPromise = null;
    this.refCount = 0;
  }

  /**
   * List all available models from OpenCode providers.
   * Uses provider.list() to get the full catalog (not just configured providers).
   * Each model ID is formatted as `providerID/modelID`.
   * @returns Flattened array of models with composite IDs
   */
  async listModels(
    config?: ServerManagerConfig
  ): Promise<Array<{ id: string; displayName: string; description?: string; isDefault?: boolean; providerName?: string }>> {
    const client = await this.acquire(config);

    try {
      const response = await client.provider.list();

      if (!response.data?.all) {
        // Fallback to config.providers() if provider.list() is not available
        return this.listModelsFromConfig(client);
      }

      const models: Array<{ id: string; displayName: string; description?: string; isDefault?: boolean; providerName?: string }> = [];

      for (const provider of response.data.all) {
        if (!provider.models) continue;

        // Handle models as either a Record or an Array
        const entries: Array<[string, OpencodeModel]> = Array.isArray(provider.models)
          ? (provider.models as OpencodeModel[]).map((m) => [m.id, m] as [string, OpencodeModel])
          : Object.entries(provider.models);

        for (const [modelKey, model] of entries) {
          // Format ID as providerID/modelID
          const id = `${provider.id}/${modelKey}`;
          models.push({
            id,
            displayName: model.name || modelKey,
            description: undefined,
            providerName: provider.name || provider.id,
            ...(id === OPENCODE_DEFAULT_MODEL ? { isDefault: true } : {}),
          });
        }
      }

      return models;
    } finally {
      this.release();
    }
  }

  /**
   * Fallback: list models from config.providers() (only configured providers).
   */
  private async listModelsFromConfig(
    client: OpencodeClient
  ): Promise<Array<{ id: string; displayName: string; description?: string; isDefault?: boolean; providerName?: string }>> {
    const response = await client.config.providers();

    if (!response.data?.providers) {
      return [];
    }

    const models: Array<{ id: string; displayName: string; description?: string; isDefault?: boolean; providerName?: string }> = [];

    for (const provider of response.data.providers) {
      if (!provider.models) continue;

      const entries: Array<[string, OpencodeModel]> = Array.isArray(provider.models)
        ? (provider.models as OpencodeModel[]).map((m) => [m.id, m] as [string, OpencodeModel])
        : Object.entries(provider.models);

      for (const [modelKey, model] of entries) {
        const id = `${provider.id}/${modelKey}`;
        models.push({
          id,
          displayName: model.name || modelKey,
          description: undefined,
          providerName: provider.name || provider.id,
          ...(id === OPENCODE_DEFAULT_MODEL ? { isDefault: true } : {}),
        });
      }
    }

    return models;
  }

  private async startServer(config?: ServerManagerConfig): Promise<OpencodeClient> {
    const createOpencode = await this.loadSDK();

    // These MUST be set on process.env, not passed to createOpencode. The SDK's
    // ServerOptions type (1.2.6) is { hostname, port, signal, timeout, config } —
    // it has no `env` field, and server.js spawns `opencode` with
    // `env: { ...process.env, OPENCODE_CONFIG_CONTENT }`. Anything handed to the
    // SDK as `env` is silently discarded. Mutating process.env is the only way to
    // reach the spawned server; there is no per-spawn env hook in this SDK version.
    applyOpenCodeEnv(config?.stoneforgeRoot);

    // NOTE: `cwd` is deliberately NOT passed. The SDK's ServerOptions has no cwd
    // field and would discard it, and the server is a shared singleton anyway, so
    // a single startup directory could never be right for more than one session.
    // Per-session working directories are sent as `?directory=` on each
    // session-scoped request instead — see headless.ts.
    const result = await createOpencode({
      port: config?.port ?? 0,
    });

    // The SDK returns richer types; we extract what we need
    this.client = result.client as unknown as OpencodeClient;
    this.server = result.server as unknown as OpencodeServer;
    this.startPromise = null;

    return this.client;
  }

  private async loadSDK(): Promise<(...args: unknown[]) => Promise<{ client: unknown; server: unknown }>> {
    try {
      const sdk = await import('@opencode-ai/sdk');
      return sdk.createOpencode as (...args: unknown[]) => Promise<{ client: unknown; server: unknown }>;
    } catch {
      throw new Error(
        'OpenCode SDK is not installed. Install it with: npm install @opencode-ai/sdk'
      );
    }
  }
}

/** Singleton instance */
export const serverManager = new OpenCodeServerManager();
