/**
 * Conversation history — the reason the agent is not an amnesiac.
 *
 * WHY THIS FILE EXISTS AT ALL: TAC hands a handler only the CURRENT message. Its own history is
 * in-process and never exposed on the payload, so without our own store every turn starts from
 * nothing — and an amnesiac agent passes every unit test in this repo, because each test drives one
 * turn. The failure only shows up when a human says "and what about the other one?" on turn two,
 * which is exactly the moment a demo is being watched.
 *
 * ZERO vendor imports, like the rest of `server/agent/`. `TurnMessage` is ours, deliberately, and
 * NOT the AI SDK's `ModelMessage`: `tests/architecture.test.ts` confines `ai` to
 * `server/agent/model/`, and putting a vendor type on this seam would break the property the bench
 * harness exists to prove at run time. `model/openai.ts` converts.
 *
 * EPHEMERAL BY DECISION, not by omission. The plan rules out a second durable store — Langfuse owns
 * durable history, and a second place to look is worse than one. So this is a process-local `Map`
 * that dies with the container, which also means a `node --watch` restart drops it and a
 * multi-instance deploy would not share it. If a demo ever needs history to survive either, the
 * honest change is a networked store behind this same port — and then `read` has to become async and
 * fold into the `Promise.all` in `run-turn.ts`, because a network hop belongs beside the prompt
 * fetch rather than in front of it.
 */
import type { ToolLogger } from './tools/registry.ts';
import type { HistoryPort, TurnMessage } from './types.ts';

/**
 * How much of a conversation the model is told about, in messages — so 20 is ten user/assistant
 * exchanges.
 *
 * EVEN ON PURPOSE. Turns are appended as a user+assistant PAIR, so an even cap drops whole
 * exchanges and an odd one would leave history permanently starting with a dangling assistant
 * message.
 *
 * The cap is a latency decision as much as a memory one: every retained message is re-sent on every
 * turn, so it is input tokens on the critical path in front of the first spoken word. Ten exchanges
 * is longer than any demo conversation observed so far and still a bounded prompt.
 */
export const HISTORY_MAX_MESSAGES = 20;

/**
 * How many conversations are remembered at once.
 *
 * A demo box runs for a week without a restart, and every inbound call or text mints a new
 * conversation id that is never explicitly ended if the WebSocket dies unheard. Unbounded, that is a
 * slow leak no test would notice — the map only ever grows, each entry holding up to
 * `HISTORY_MAX_MESSAGES` transcript strings. 200 concurrent conversations is far beyond a demo's
 * real load, so in practice eviction is a backstop rather than a working mechanism.
 */
export const HISTORY_MAX_CONVERSATIONS = 200;

export interface HistoryLimits {
  readonly maxMessages: number;
  readonly maxConversations: number;
}

/**
 * `HistoryPort` plus what only an owner needs.
 *
 * The port itself lives on the seam in `./types.ts`, beside `MemoryComposePort`, so `run-turn.ts`
 * depends on the interface and not on this file. `size()` is here rather than there because a
 * consumer of history has no business asking how many other conversations exist — it is for the
 * operator console and for asserting that eviction actually removed an entry.
 */
export interface HistoryStore extends HistoryPort {
  /** Conversations currently held. For the operator console and for asserting eviction. */
  size(): number;
}

/**
 * A bounded, process-local history store.
 *
 * EVICTION POLICY, both dimensions:
 *
 *  - **Messages within a conversation: oldest-first.** The newest `maxMessages` survive. The recent
 *    exchange is what the next turn needs; the opening pleasantries are what it can afford to lose.
 *  - **Conversations within the map: least-recently-USED.** Used, not written — `read` refreshes
 *    recency too. That distinction is load-bearing rather than pedantic: recency-on-write-only
 *    evicts the conversation whose next turn is already in flight, and on voice that is the live
 *    call. The symptom would be an agent that forgets mid-sentence, only under load, only on a box
 *    that has been up a while.
 *
 * A JS `Map` iterates in insertion order, so delete-then-set is the whole LRU mechanism.
 *
 * ONE of those two evictions is reported and the other is not, which is a deliberate asymmetry.
 * Trimming messages is steady state — every conversation past ten exchanges trims on every turn, so
 * a line there would appear once per turn forever and bury anything real. Dropping a whole
 * conversation means the box has been up long enough to lose state nobody asked it to lose, and the
 * symptom downstream ("the agent forgot who I was") is otherwise undiagnosable.
 */
export function createHistory(
  limits: Partial<HistoryLimits> = {},
  logger?: ToolLogger,
): HistoryStore {
  const maxMessages = limits.maxMessages ?? HISTORY_MAX_MESSAGES;
  const maxConversations = limits.maxConversations ?? HISTORY_MAX_CONVERSATIONS;

  const conversations = new Map<string, readonly TurnMessage[]>();

  /** Re-insert at the end, which is what makes this the most recently used entry. */
  const touch = (conversationId: string, messages: readonly TurnMessage[]): void => {
    conversations.delete(conversationId);
    conversations.set(conversationId, messages);
  };

  return {
    read(conversationId) {
      const found = conversations.get(conversationId);
      if (found === undefined) return [];
      touch(conversationId, found);
      // A copy, so a caller that mutates what it was handed cannot corrupt the store. `runTurn`
      // spreads this into a message array it then extends with the current utterance, which is
      // exactly the shape of caller that would otherwise write the user's message into history a
      // turn early.
      return [...found];
    },

    append(conversationId, messages) {
      // An empty batch must not mint an entry, or every failed turn would leave a conversation in
      // the map holding nothing and occupying a slot against the cap.
      if (messages.length === 0) return;

      const next = [...(conversations.get(conversationId) ?? []), ...messages];
      touch(conversationId, next.length > maxMessages ? next.slice(next.length - maxMessages) : next);

      // `while`, not `if`: a lowered cap on a restart-free box should settle in one pass rather than
      // leak one entry per append forever.
      while (conversations.size > maxConversations) {
        const oldest = conversations.keys().next();
        if (oldest.done === true) break;
        conversations.delete(oldest.value);
        logger?.warn(
          { conversationId: oldest.value, held: conversations.size, maxConversations },
          `history: evicted conversation ${oldest.value} at the ${maxConversations}-conversation cap`,
        );
      }
    },

    clear(conversationId) {
      conversations.delete(conversationId);
    },

    size: () => conversations.size,
  };
}
