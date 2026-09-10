/**
 * The Twilio-free bench harness — the first point where a human can talk to the agent.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE MUST NEVER IMPORT `twilio-agent-connect` OR `twilio`, AND THAT IS ITS POINT.
 *
 * `tests/architecture.test.ts` asserts it statically, but the real proof is behavioural: this route
 * drives a COMPLETE turn — prompt fetch, memory compose, tool resolve, streaming model call, history
 * — with TAC never loaded into the process. An architecture test on import strings can be satisfied
 * by a file that simply doesn't happen to import TAC yet; a working bench proves `runTurn` is
 * genuinely channel-agnostic, because it is the same function voice and SMS will call at T12/T13.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY TOKENS STREAM ON THIS RESPONSE AND NOT OVER THE OBS SSE HUB. The hub in `./sse.ts` broadcasts
 * `ObsEvent`s to every attached console, and every publish also lands in the bus's 500-entry ring
 * buffer that `/events/stream` replays to each new client. Pushing token deltas through it would
 * cost all three properties that matter: a 206-character answer streams ~40 deltas, so a dozen turns
 * evict every lifecycle event from the buffer; every newly-opened console would replay hundreds of
 * token fragments; and two `/bench` tabs would each receive the other's answer interleaved with
 * their own. Tokens are a REPLY TO ONE REQUEST, so they ride that request's own response. The SSE
 * primitives are still reused (`formatSse`, `SSE_HEADERS`), so there is one wire format, not two.
 *
 * The division of labour is unchanged and worth restating: this stream is the ANSWER, the obs hub is
 * the COMMENTARY. `runTurn` still publishes `turn.start`, `llm.first_token`, `turn.end` and the rest
 * to the bus exactly as voice will, so the operator console at T19 needs no bench-specific code.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTurn } from '../agent/run-turn.ts';
import { turnSpans } from '../agent/spans.ts';
import { passthroughMemory } from '../agent/memory.ts';
import { createHistory, type HistoryStore } from '../agent/history.ts';
import { createLangfusePromptPort } from '../agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../agent/prompt/port.ts';
import { createOpenAiModelPort } from '../agent/model/openai.ts';
import { resolve } from '../agent/tools/resolve.ts';
import type { ToolLogger } from '../agent/tools/registry.ts';
import type { TurnDeps } from '../agent/types.ts';
import { capabilities, unavailable, type AppConfig, type Capabilities } from '../config.ts';
import { childLogger } from '../logging.ts';
import type { ObsBus } from '../obs/bus.ts';
import {
  startConversationSpan,
  withTurnSpan,
  type ConversationSpan,
  type SpanLike,
} from '../obs/spans.ts';
import { BENCH_TURN_PATH } from '../../shared/twilio-paths.ts';
import { formatSse, SSE_HEADERS, type SseSink } from './sse.ts';
import type { App } from './types.ts';

const log = childLogger('bench');

/** Longest a bench conversation may sit idle before its trace is closed. */
export const BENCH_CONVERSATION_TTL_MS = 30 * 60_000;
/** Bench conversations held at once. A browser tab minting ids is the only source. */
export const BENCH_MAX_CONVERSATIONS = 50;

const BenchTurnBody = z
  .object({
    text: z.string().trim().min(1).max(4000),
    /** Absent on the first turn; the browser echoes back what `start` gave it. */
    conversationId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * Per-conversation trace roots, so turn 2 lands in turn 1's trace.
 *
 * The same shape voice needs at T13, exercised here where no phone is required. Voice carries its
 * traceparent on `session.metadata` because TAC persists nothing; the bench has no session object at
 * all, so it keeps them here and the browser supplies the id.
 *
 * BOUNDED AND SWEPT, because the bench has NO disconnect signal. Voice gets
 * `webSocketDisconnected`; a browser tab that is closed tells this process nothing. An unswept
 * registry would therefore hold a conversation span open forever — and an unended span does not
 * reach Langfuse AT ALL (see `../obs/spans.ts`), so the symptom is a whole missing trace with no
 * error anywhere.
 */
export interface ConversationRegistry {
  /** The traceparent for this conversation, starting its root span on first use. */
  traceparentFor(conversationId: string): string | undefined;
  /** End the root span and forget the conversation. Idempotent. */
  end(conversationId: string): void;
  /** End every conversation idle past the ttl. Returns how many. */
  sweep(): number;
  size(): number;
  /** End every conversation, so the last trace of a run is not lost on shutdown. */
  shutdown(): void;
}

export function createConversationRegistry(
  opts: {
    readonly ttlMs?: number;
    readonly maxConversations?: number;
    readonly now?: () => number;
    readonly start?: (conversationId: string) => ConversationSpan;
  } = {},
): ConversationRegistry {
  const ttlMs = opts.ttlMs ?? BENCH_CONVERSATION_TTL_MS;
  const maxConversations = opts.maxConversations ?? BENCH_MAX_CONVERSATIONS;
  const now = opts.now ?? Date.now;
  const start =
    opts.start ??
    ((conversationId: string): ConversationSpan =>
      startConversationSpan('conversation.bench', { conversationId }));

  interface Entry {
    readonly span: ConversationSpan;
    readonly traceparent: string | undefined;
    lastUsedAt: number;
  }
  const entries = new Map<string, Entry>();

  const close = (conversationId: string, entry: Entry, why: string): void => {
    entry.span.update({ metadata: { closedBecause: why } });
    entry.span.end();
    entries.delete(conversationId);
  };

  return {
    traceparentFor(conversationId) {
      const existing = entries.get(conversationId);
      if (existing !== undefined) {
        existing.lastUsedAt = now();
        // Re-insert so Map order is least-recently-used, matching `history.ts`.
        entries.delete(conversationId);
        entries.set(conversationId, existing);
        return existing.traceparent;
      }

      const span = start(conversationId);
      entries.set(conversationId, { span, traceparent: span.traceparent, lastUsedAt: now() });

      while (entries.size > maxConversations) {
        const oldest = entries.entries().next();
        if (oldest.done === true) break;
        const [id, entry] = oldest.value;
        close(id, entry, 'evicted at the conversation cap');
        log.warn({ conversationId: id, maxConversations }, 'bench: evicted a conversation at the cap');
      }

      return span.traceparent;
    },

    end(conversationId) {
      const entry = entries.get(conversationId);
      if (entry !== undefined) close(conversationId, entry, 'ended');
    },

    sweep() {
      const at = now();
      let swept = 0;
      for (const [id, entry] of [...entries]) {
        if (at - entry.lastUsedAt < ttlMs) continue;
        close(id, entry, `idle past ${ttlMs}ms`);
        swept += 1;
      }
      return swept;
    },

    size: () => entries.size,

    shutdown() {
      for (const [id, entry] of [...entries]) close(id, entry, 'shutdown');
    },
  };
}

export interface BenchTurnRequest {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
}

export interface BenchTurnDeps {
  readonly turn: TurnDeps;
  readonly conversations: ConversationRegistry;
  /**
   * Injected ONLY so a test can assert the span is still open when the last token is written — the
   * single most important property of this file. Defaults to the real `withTurnSpan`.
   */
  readonly withTurn?: <T>(
    name: string,
    traceparent: string | undefined,
    fn: (span: SpanLike) => Promise<T>,
  ) => Promise<T>;
  readonly logger?: ToolLogger;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Drive one bench turn, writing SSE frames to `sink`.
 *
 * Transport-agnostic on the same `SseSink` seam the hub uses, so this is unit-testable without a
 * socket — which is what makes the span-ordering assertion in `tests/bench-route.test.ts` possible
 * at all.
 *
 * Frames: `start` once, `token` per delta, then exactly one of `done` or `error`. The sink is closed
 * exactly once, on every path.
 */
export async function streamBenchTurn(
  sink: SseSink,
  request: BenchTurnRequest,
  deps: BenchTurnDeps,
): Promise<void> {
  const logger = deps.logger ?? log;
  const withTurn = deps.withTurn ?? withTurnSpan;
  const { conversationId } = request;

  // A dead socket is discovered by writing to it — SSE has no other disconnect signal. Once gone,
  // stop writing but let the turn finish: `runTurn`'s `done` owns ending the `llm.stream` span, and
  // abandoning the drain here would leave it unended and therefore absent from Langfuse.
  let gone = false;
  const send = (event: string, data: Record<string, unknown>): void => {
    if (gone) return;
    try {
      sink.write(formatSse(event, data));
    } catch {
      gone = true;
    }
  };

  const traceparent = deps.conversations.traceparentFor(conversationId);

  try {
    await withTurn('turn.bench', traceparent, async (span) => {
      send('start', { conversationId });

      const { tokens, done } = await runTurn(
        {
          conversationId,
          channel: 'bench',
          userText: request.text,
          // No TAC memory on the bench, which is the passthrough port's whole reason to exist.
          memory: null,
          // Voice carries the traceparent here; the bench keeps it in the registry instead, so this
          // is deliberately empty rather than a copy of something already applied above.
          sessionMetadata: {},
          profileId: null,
          abortSignal: request.abortSignal,
          span,
        },
        deps.turn,
      );

      // ══ NOTHING MAY BE AWAITED BETWEEN `runTurn` RESOLVING AND THIS LOOP. ══
      // `done` gets ONE macrotask of grace before it decides nobody is listening. A caller that
      // awaits anything slower in between still receives every token, but `ttftMs`/`totalMs` come
      // back null — silent, and visible only as an empty latency column. `send` is synchronous for
      // exactly this reason.
      for await (const delta of tokens) send('token', { delta });

      const result = await done;
      send('done', {
        text: result.text,
        toolCalls: result.toolCalls.map((c) => c.name),
        steps: result.steps,
        ttftMs: result.ttftMs,
        modelTtftMs: result.modelTtftMs,
        totalMs: result.totalMs,
        aborted: result.aborted,
        usage: result.usage,
        prompt: result.prompt,
        model: result.model,
      });
    });
  } catch (err) {
    // The browser is holding this socket open. Letting the rejection escape would leave the fetch
    // hanging until it timed out, which reads as a slow agent rather than a failed one. `runTurn`
    // has already published its own `error` and `turn.end` events to the bus.
    logger.error({ err, conversationId }, 'bench: turn failed');
    send('error', { error: errorMessage(err) });
  } finally {
    try {
      sink.close?.();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Build the real `TurnDeps` for the bench.
 *
 * Separate from `registerBenchRoutes` so the route can be tested against fakes: the route takes
 * `TurnDeps` injected, and only this function knows how to construct the live ports. Same seam
 * `scripts/verify-turn.ts` uses.
 */
export function createBenchTurnDeps(deps: {
  readonly config: AppConfig;
  readonly bus: ObsBus;
  readonly history: HistoryStore;
  readonly nodeEnv: string | undefined;
}): TurnDeps {
  const { config, bus, history } = deps;
  if (config.openai === null) {
    // Unreachable through the route, which gates on `caps.llm` first. Explicit anyway: the
    // alternative is a confusing null-deref inside the model port on a misconfigured box.
    throw new Error('createBenchTurnDeps requires OPENAI_API_KEY; gate on capabilities.llm first');
  }
  return {
    prompts: createLangfusePromptPort({
      langfuse: config.langfuse,
      bus,
      ttlMs: promptCacheTtlMs(deps.nodeEnv),
    }),
    // T8's resolver with its process-wide arguments applied. `capabilities` comes from config,
    // which is why `server/agent/` never reads the environment itself.
    tools: (names, turn) =>
      resolve(names, {
        capabilities: capabilities(config),
        bus,
        conversationId: turn.conversationId,
        channel: turn.channel,
      }),
    model: createOpenAiModelPort({ apiKey: config.openai.apiKey }),
    composeMemory: passthroughMemory,
    obs: bus,
    spans: turnSpans,
    branding: { persona: 'Ada, a customer support agent', companyName: 'Northwind Traders' },
    history,
  };
}

export interface BenchRoutes {
  readonly history: HistoryStore;
  readonly conversations: ConversationRegistry;
  shutdown(): void;
}

/**
 * Mount `POST /api/bench/turn`.
 *
 * `reply.hijack()` for the same reason `routes-obs.ts` needs it: without it Fastify tries to
 * serialise a body and end the response, and the stream closes as the handler returns.
 */
export function registerBenchRoutes(
  app: App,
  deps: {
    readonly config: AppConfig;
    readonly caps: Capabilities;
    readonly turn?: TurnDeps;
    readonly bus: ObsBus;
  },
): BenchRoutes {
  const history = createHistory(undefined, log);
  const conversations = createConversationRegistry();

  app.post(BENCH_TURN_PATH, (request, reply) => {
    // The degradation contract every capability-gated route follows: 503 naming the variable, rather
    // than a stack trace or a silent 500. The page stays inspectable with no key configured.
    if (!deps.caps.llm) {
      void reply.code(503).send(unavailable(deps.config, 'agent'));
      return;
    }

    const parsed = BenchTurnBody.safeParse(request.body);
    if (!parsed.success) {
      void reply.code(400).send({ error: 'bad_request', detail: z.treeifyError(parsed.error) });
      return;
    }

    const turnDeps =
      deps.turn ??
      createBenchTurnDeps({ config: deps.config, bus: deps.bus, history, nodeEnv: process.env.NODE_ENV });

    // Opportunistic rather than on a timer: a `setInterval` would need `unref` to stop holding the
    // process open in tests, and there is nothing to sweep when nobody is using the bench.
    conversations.sweep();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, SSE_HEADERS);

    // A closed tab should stop the model call rather than pay for tokens nobody will read. This is
    // also the bench's stand-in for a voice barge-in, so the abort path gets exercised without a
    // phone — including T10's decision to keep the partial answer in history.
    //
    // ON THE RESPONSE, NOT THE REQUEST, and that distinction is a bug this file already shipped once.
    // `routes-obs.ts` listens on `request.raw` and is right to: it serves a GET, and with no request
    // body that stream stays open for the life of the connection. This is a POST, and a request
    // stream whose body has been read is a request stream that has CLOSED — measured at +3 ms against
    // a client that stayed connected for 905 ms. Every bench turn therefore aborted before its first
    // token while the HTTP exchange still looked perfectly healthy: 200, correct SSE headers, and a
    // `done` frame reporting `aborted: true` with no tokens and null timings.
    //
    // `reply.raw` emits `close` when the response completes OR when the peer vanishes early, which is
    // the signal actually wanted. It therefore also fires after our own `res.end()`, hence `settled`:
    // aborting an already-finished turn changes nothing, but it would log something untrue.
    const abort = new AbortController();
    let settled = false;
    res.on('close', () => {
      if (!settled) abort.abort();
    });

    void streamBenchTurn(
      {
        write: (chunk) => void res.write(chunk),
        close: () => {
          settled = true;
          res.end();
        },
      },
      {
        conversationId: parsed.data.conversationId ?? `bench-${randomUUID()}`,
        text: parsed.data.text,
        abortSignal: abort.signal,
      },
      { turn: turnDeps, conversations, logger: log },
    );
  });

  return {
    history,
    conversations,
    shutdown: () => conversations.shutdown(),
  };
}
