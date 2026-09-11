/**
 * Per-conversation trace roots, so turn 2 lands in turn 1's trace.
 *
 * Extracted from `../http/routes-bench.ts` at T12, where SMS needed the identical shape. The bench
 * keeps a one-line re-export, so its tests are untouched.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS BOUNDED AND SWEPT, on every channel, and not just tidy housekeeping:
 *
 * an unended span does not reach Langfuse AT ALL (see `./spans.ts`). So an unswept registry does not
 * merely leak memory — it produces a whole MISSING TRACE with no error anywhere to explain it. Both
 * callers reach that state by different routes:
 *
 *  - the bench has NO disconnect signal whatsoever. A closed browser tab tells this process nothing.
 *  - SMS has one, but it is unreliable: `tac.onConversationEnded` fires only when Conversation
 *    Orchestrator marks the conversation CLOSED. INACTIVE does not end it, and whether CLOSED ever
 *    arrives depends on the CO configuration's `statusTimeouts`.
 *
 * The TTL sweep is therefore the backstop in both cases, not the exception.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THIS IS ALSO THE TRACEPARENT CARRIER FOR SMS, deliberately in preference to TAC's
 * `session.metadata`. Metadata would seem the natural home — it is the only thing TAC persists across
 * turns, and `./spans.ts` describes it as the cross-turn carrier for voice. But the two have different
 * lifetimes: `session.metadata` survives until CLOSED, while this registry sweeps on a TTL and *ends*
 * the root span. Reading metadata first would therefore rehydrate turn N+1 as a child of an already-
 * ended, already-exported root — a trace whose root duration does not cover its children. TAC's
 * conversationId is stable across turns, so keying here is sufficient AND cannot go stale.
 */
import { childLogger } from '../logging.ts';
import { startConversationSpan, type ConversationSpan } from './spans.ts';

/**
 * Just the level this module uses. Structural rather than pino's type or `agent/`'s `ToolLogger`, so
 * `obs/` keeps depending on nothing above it.
 */
export interface RegistryLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

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

export interface ConversationRegistryOptions {
  /**
   * Span name for each conversation root — `conversation.bench`, `conversation.sms`. Also used in the
   * eviction warning, so a shared module cannot claim one channel's name for another's event.
   */
  readonly spanName?: string;
  readonly ttlMs?: number;
  readonly maxConversations?: number;
  readonly now?: () => number;
  readonly logger?: RegistryLogger;
  /** Injected by tests that need to count or fake root spans. */
  readonly start?: (conversationId: string) => ConversationSpan;
}

/** Bench default. A browser tab minting ids is the only source, and a demo tab is short-lived. */
export const DEFAULT_CONVERSATION_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_CONVERSATIONS = 50;

export function createConversationRegistry(
  opts: ConversationRegistryOptions = {},
): ConversationRegistry {
  const spanName = opts.spanName ?? 'conversation.bench';
  const ttlMs = opts.ttlMs ?? DEFAULT_CONVERSATION_TTL_MS;
  const maxConversations = opts.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? childLogger('conversations');
  const start =
    opts.start ??
    ((conversationId: string): ConversationSpan => startConversationSpan(spanName, { conversationId }));

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
        // Re-insert so Map order is least-recently-used, matching `../agent/history.ts`.
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
        log.warn({ conversationId: id, maxConversations, spanName }, `${spanName}: evicted a conversation at the cap`);
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
