/**
 * The Langfuse-backed `PromptPort`. The ONLY file in the repo permitted to import
 * `@langfuse/client` (`tests/architecture.test.ts` enforces it), so that everything above this
 * line can be tested with no Langfuse at all.
 *
 * Two rules govern the whole file:
 *
 *  1. `get()` NEVER throws and NEVER rejects. Network error, 404, bad credentials, a `config`
 *     that fails validation, no Langfuse configured — every one of them returns the compiled
 *     default with `version: 'fallback'`. A prompt lookup must not be able to end a phone call.
 *  2. Fetch by LABEL, never by version number. `production` is a pointer the operator moves, and
 *     that pointer is the entire rollback mechanism.
 *
 * No span is created here. T9 owns the `prompt.fetch` span that wraps this call; instrumenting it
 * on both sides puts the same step in the waterfall twice, which reads as a bug in the tracing.
 */
import { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';
import type { AppConfig } from '../../config.ts';
import { childLogger } from '../../logging.ts';
import { obsBus, type ObsBus } from '../../obs/bus.ts';
import { fallbackPrompt } from './defaults.ts';
import {
  PRODUCTION_LABEL,
  PromptConfigSchema,
  promptCacheTtlMs,
  type PromptPort,
  type ResolvedPrompt,
} from './port.ts';

/**
 * Deliberately NOT `.strict()`, unlike the config schema. Langfuse tags each chat message with a
 * `type` discriminator and may add more fields; extras here are the vendor's business. An unknown
 * key in `config`, by contrast, is an operator's typo, which is why that one is strict.
 *
 * A placeholder entry (`{type: 'placeholder', name}`) has no `role` and so fails this parse — the
 * right outcome, since nothing downstream knows what to do with one.
 */
const MessagesSchema = z.array(
  z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }),
);

/**
 * A hung Langfuse must cost at most one short pause, once per TTL window, rather than a pause on
 * every turn — hence a timeout well below what the Fern client defaults to, `maxRetries: 0`, and a
 * cache that remembers the fallback too.
 */
const FETCH_TIMEOUT_MS = 2_000;

/** Why the compiled default is being served. Reaches both the log line and the console. */
export type FallbackReason =
  | 'not_configured'
  | 'fetch_failed'
  | 'invalid_config'
  | 'invalid_messages';

/**
 * The only shape this port needs from a Langfuse prompt. `ChatPromptClient` satisfies it
 * structurally, and a test can satisfy it with an object literal — which is how the fallback
 * paths get exercised without a mocking library.
 */
export interface FetchedPrompt {
  readonly version: number;
  readonly labels: readonly string[];
  /** Raw chat messages, validated by `MessagesSchema` rather than trusted. */
  readonly prompt: unknown;
  readonly config: unknown;
  /** Serialised prompt reference; becomes `experimental_telemetry.metadata.langfusePrompt`. */
  toJSON(): string;
}

export type PromptFetcher = (name: string, label: string) => Promise<FetchedPrompt>;

/** Structural, so `childLogger('prompt')` fits and a test can collect lines instead. */
export interface PromptLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface LangfusePromptDeps {
  /** `AppConfig.langfuse`. `null` is the documented not-configured case: every get() falls back. */
  readonly langfuse: AppConfig['langfuse'];
  readonly logger?: PromptLogger;
  readonly bus?: Pick<ObsBus, 'publish'>;
  /**
   * Replaces the Langfuse client outright. Tests inject one so the fallback paths can be driven
   * without credentials, a network, or `vi.mock`.
   */
  readonly fetcher?: PromptFetcher;
  readonly label?: string;
  readonly ttlMs?: number;
  /** Clock for the cache. Injected so the TTL can be tested without waiting for it. */
  readonly now?: () => number;
}

interface Resolution {
  readonly resolved: ResolvedPrompt;
  readonly reason: FallbackReason | null;
}

const clientFetcher = (creds: NonNullable<AppConfig['langfuse']>): PromptFetcher => {
  // Built on first use, inside the caller's try/catch, so even a constructor failure lands on the
  // fallback path instead of at boot.
  let client: LangfuseClient | undefined;
  return (name, label) => {
    client ??= new LangfuseClient({
      baseUrl: creds.baseUrl,
      publicKey: creds.publicKey,
      secretKey: creds.secretKey,
    });
    return client.prompt.get(name, {
      type: 'chat',
      label,
      // The SDK has its own prompt cache. Disabled, because two caches make the duration in the
      // `prompt.fetch` span mean nothing, and only ours can be observed through this port.
      cacheTtlSeconds: 0,
      maxRetries: 0,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      // No `fallback:` either — the SDK's version of it reports `version: 0` and an empty config,
      // where ours reports `'fallback'` and the real compiled config.
    });
  };
};

export function createLangfusePromptPort(deps: LangfusePromptDeps): PromptPort {
  const log = deps.logger ?? childLogger('prompt');
  const bus = deps.bus ?? obsBus;
  const label = deps.label ?? PRODUCTION_LABEL;
  // NODE_ENV is read here rather than in port.ts, and via a function rather than at module load,
  // so the port stays a pure seam and `server/config.ts` remains the only top-level env reader.
  const ttlMs = deps.ttlMs ?? promptCacheTtlMs(process.env.NODE_ENV);
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetcher ?? (deps.langfuse === null ? null : clientFetcher(deps.langfuse));

  const cache = new Map<string, { readonly at: number; readonly resolution: Resolution }>();

  const fallback = (name: string, reason: FallbackReason, err?: unknown): Resolution => {
    log.warn({ prompt: name, reason, err }, `prompt: serving compiled default for ${name} (${reason})`);
    return { resolved: fallbackPrompt(name), reason };
  };

  const resolve = async (name: string): Promise<Resolution> => {
    if (fetcher === null) return fallback(name, 'not_configured');

    // One guard around the whole body: anything the vendor can do — reject, return a surprise,
    // throw from toJSON() — has the same correct answer, which is the compiled default.
    try {
      const fetched = await fetcher(name, label);

      // A prompt created without a config is legitimate and gets every schema default; only a
      // config that is present and wrong falls back.
      const config = PromptConfigSchema.safeParse(fetched.config ?? {});
      if (!config.success) return fallback(name, 'invalid_config', config.error);

      const messages = MessagesSchema.safeParse(fetched.prompt);
      if (!messages.success) return fallback(name, 'invalid_messages', messages.error);

      return {
        resolved: {
          name,
          version: fetched.version,
          // The label we asked for, not `fetched.labels` — "we are serving whatever `production`
          // points at" is the operator-meaningful fact, and `version` above says which that is.
          label,
          messages: messages.data,
          config: config.data,
          telemetryLink: fetched.toJSON(),
        },
        reason: null,
      };
    } catch (err) {
      return fallback(name, 'fetch_failed', err);
    }
  };

  const publish = (resolution: Resolution, durationMs: number, cached: boolean): void => {
    const { resolved, reason } = resolution;
    const version = resolved.version === 'fallback' ? 'fallback' : `v${resolved.version}`;
    bus.publish({
      kind: 'prompt.fetch',
      summary: `${resolved.name} ${version}${cached ? ' (cached)' : ''}${reason === null ? '' : ` — ${reason}`}`,
      durationMs,
      payload: {
        name: resolved.name,
        version: resolved.version,
        label: resolved.label,
        cached,
        ...(reason !== null && { reason }),
      },
    });
  };

  return {
    async get(name) {
      const startedAt = now();

      const hit = cache.get(name);
      if (hit !== undefined && startedAt - hit.at < ttlMs) {
        publish(hit.resolution, now() - startedAt, true);
        return hit.resolution.resolved;
      }

      const resolution = await resolve(name);
      // Fallbacks are cached too, on purpose: while Langfuse is down, re-asking it on every turn
      // buys nothing and costs FETCH_TIMEOUT_MS of silence each time. The TTL bounds how long a
      // blip is remembered.
      cache.set(name, { at: now(), resolution });
      publish(resolution, now() - startedAt, false);
      return resolution.resolved;
    },
  };
}
