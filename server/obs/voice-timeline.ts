/**
 * The per-call timeline state that makes one voice trace continuous.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS SOLVES. `turn.voice` used to start at the final transcript and end when the
 * model stopped streaming, so a 44 s call showed roughly 11 s of spans and 33 s of nothing. The
 * missing time is not ours in the sense of being CPU we spent — it is the caller listening to the
 * answer, then thinking, then speaking, then the recogniser deciding they had finished. But it is
 * absolutely the caller's experience of the call, and a waterfall that omits three quarters of it
 * cannot answer "where did the time go?".
 *
 * Two of those instants arrive on WebSocket frames that no turn handler is inside — an `interrupt`
 * is dispatched from TAC's own message handler while our `prompt` handler is still awaiting the
 * send. So the boundaries have to be recorded somewhere both handlers can reach, which is what this
 * module is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * DELIBERATELY VENDOR-FREE. It imports one TYPE from `./spans.ts` and nothing else, so it is
 * exercisable against a hand-written `TimelineSpan` and carries no knowledge of Twilio, TAC or
 * OpenTelemetry. Span CREATION stays in `./spans.ts`, which is the repo's only sanctioned factory;
 * this module only decides which spans exist and what instants they cover.
 *
 * BOUNDED AND SWEPT, for the same reason as `./conversations.ts`: it holds a LIVE span handle, and
 * an unended span reaches Langfuse not at all. Every close path of the conversation registry runs
 * `forget` through its `onClose` hook, and the cap below is the backstop for a conversation that
 * somehow outlives its root.
 */
import type { TimelineSpan } from './spans.ts';

/** Just the level this module uses, structurally, so `obs/` keeps depending on nothing above it. */
export interface TimelineLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** Why a turn's bot-output boundary landed where it did. Recorded on the turn and on `tts.send`. */
export type TurnEnding =
  /** `sendStreamingResponse` resolved after streaming at least one token, so TAC sent `last: true`. */
  | 'last-token'
  /** The fallback line went out via `sendResponse`, which sends its own end-of-turn marker. */
  | 'fallback'
  /** An inbound `interrupt` frame. TAC sent the end-of-turn marker itself. */
  | 'interrupt'
  /** Nothing reached the caller — a dead socket, or a zero-token turn on a path that says nothing. */
  | 'no-output'
  /** The entry was evicted at the cap with a turn still live. Should not happen; visible if it does. */
  | 'evicted';

export interface TurnClose {
  /** The bot-output boundary: epoch ms of the `last: true` send, or of the interrupt receipt. */
  readonly atMs: number;
  readonly aborted: boolean;
  readonly ending: TurnEnding;
}

export interface VoiceTimeline {
  /**
   * Register the live turn at `prompt` receipt, and return the PREVIOUS bot-output boundary so the
   * caller can draw `caller.turn` over the gap — or `null` when there was no prior bot output (the
   * first turn of a call, or a turn whose predecessor said nothing at all).
   *
   * The gap is accumulated for the call-level statistic here rather than at the call site, so the
   * two cannot disagree about which turns counted.
   */
  beginTurn(conversationId: string, span: TimelineSpan, atMs: number): number | null;
  /**
   * The first non-empty text token went out. Called from inside the send generator — no awaits.
   *
   * `ownerSpan` is the caller's own turn span, and supplying it is what keeps a handler that
   * outlived its turn from stamping its successor's — see `completeTurn`.
   */
  markFirstToken(conversationId: string, atMs: number, ownerSpan?: TimelineSpan): void;
  /**
   * The live turn span, or `null` once the turn has been completed. This is how an inbound
   * `interrupt` — dispatched with no ambient context and no reference to the prompt handler's
   * closure — reaches the span it needs to annotate.
   */
  liveTurn(conversationId: string): TimelineSpan | null;
  /**
   * Record the live turn's bot-output boundary WITHOUT closing the span, and move the next
   * `caller.turn`'s origin to it immediately.
   *
   * ══ THIS IS THE INTERRUPT PATH, AND WHY IT DOES NOT END THE SPAN. ══
   *
   * A barge-in's boundary is known — the interrupt receipt — several hundred milliseconds before the
   * prompt handler can finish. Ending the span here was measured to cost the turn every attribute
   * `../agent/run-turn.ts` writes inside `done`: `langfuse.observation.output`, `tools.called`,
   * `turn.total_model_ms`. OpenTelemetry's `Span.setAttribute` returns early once `_isSpanEnded()`,
   * so those writes are dropped in silence, and a barged-in turn showed in Langfuse with no output
   * text and no tool list — on the one ending that is ordinary operation on a call.
   *
   * So the instant is PARKED here and the span is ended by whichever closer arrives next
   * (`completeTurn` from the prompt handler's `finally`, in the ordinary case, which runs after
   * `await done`). Every closer prefers a recorded boundary over its own, so the recorded turn still
   * ends AT the interrupt however it is closed. First boundary wins; a second `interrupt` frame for
   * the same turn changes nothing.
   */
  recordBoundary(conversationId: string, close: TurnClose): void;
  /**
   * Close the live turn: draw `tts.send`, write the re-anchored turn metadata, end the span AT the
   * boundary, and record the boundary for the next `caller.turn`. A recorded boundary
   * (`recordBoundary`) wins over `close`.
   *
   * Does nothing when no turn is live, so the second closer on any path is a no-op.
   *
   * `ownerSpan` NARROWS THAT TO "no turn of MINE is live", and it is not decoration. Every method
   * here is keyed by conversation id alone, while `handleVoicePrompt` can outlive the start of the
   * next turn: TAC serialises prompts through `promptQueues`, but `handleWebSocketDisconnect`
   * deletes that queue and `shutdown` clears it, and Conversation Orchestrator reuses one
   * conversation id per profile. Measured with two overlapping handlers on one id: the straggler's
   * `finally` closed turn B at turn A's boundary — B exported at 10 ms with A's `turn.ttfa_ms`,
   * `tts.send` at 0 ms, and B's own close silently no-opping. Passing the span the caller was handed
   * by `beginTurn` makes that unrepresentable. The interrupt path omits it deliberately: it
   * addresses whatever turn is live NOW.
   */
  completeTurn(conversationId: string, close: TurnClose, ownerSpan?: TimelineSpan): void;
  /**
   * Move the bot-output boundary later on a path that speaks AFTER its turn span has closed — the
   * outer `catch` in `handleVoicePrompt`, whose fallback line is sent from outside the span. Without
   * it the next `caller.turn` back-dates to before that line was even spoken.
   *
   * The boundary only; there is no live turn left to annotate. `recordBoundary` is the one that
   * annotates.
   */
  markBotOutput(conversationId: string, atMs: number): void;
  /**
   * Drop the conversation and return the call-level metadata for the conversation root, or
   * `undefined` when nothing was known. Idempotent.
   *
   * ONE CALL, NOT TWO, AND THAT IS THE FIX. This used to be `stats()` followed by `forget()`, and
   * `forget` is what completes a turn still live at close time — so a call that dropped mid-turn
   * reported `turns.count=0` on the root while a `turn.voice` child sat in the same trace. Measured,
   * on the commonest odd ending. Folding the two makes the ordering unrepresentable: the still-live
   * turn is counted, and only then are the statistics computed.
   */
  forget(conversationId: string): Record<string, unknown> | undefined;
  size(): number;
}

export interface VoiceTimelineOptions {
  readonly maxConversations?: number;
  readonly logger?: TimelineLogger;
}

/** Matches `VOICE_MAX_CONVERSATIONS`. The registry's `onClose` is what normally keeps this empty. */
export const DEFAULT_MAX_TIMELINES = 50;

/**
 * Nearest-rank lower median, no interpolation.
 *
 * p50 over three or four turns is a summary, not a statistic, and interpolating between two
 * measured values would invent a number that no turn actually took. `max` beside it is what makes
 * the pair useful: one bad first turn is exactly the thing a caller judges, and a median hides it.
 */
const p50 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
};

const max = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a), values[0] as number);

interface LiveTurn {
  readonly span: TimelineSpan;
  /** Epoch ms of `prompt` receipt — the anchor for both `turn.ttfa_ms` and `turn.total_ms`. */
  readonly promptAt: number;
  firstTokenAt: number | null;
  /** Parked by `recordBoundary`. Preferred by every closer over the close it was handed. */
  recordedClose: TurnClose | null;
}

interface Entry {
  live: LiveTurn | null;
  /** Epoch ms of the last `last: true` / interrupt / fallback send. `null` before the first. */
  lastBotOutputAt: number | null;
  turns: number;
  aborted: number;
  callerTurnMs: number;
  readonly ttfaMs: number[];
}

export function createVoiceTimeline(opts: VoiceTimelineOptions = {}): VoiceTimeline {
  const maxConversations = opts.maxConversations ?? DEFAULT_MAX_TIMELINES;
  const entries = new Map<string, Entry>();

  const blank = (): Entry => ({
    live: null,
    lastBotOutputAt: null,
    turns: 0,
    aborted: 0,
    callerTurnMs: 0,
    ttfaMs: [],
  });

  /**
   * Close a live turn's span so it cannot be leaked unended. The one place a turn span is ended.
   *
   * A boundary parked by `recordBoundary` WINS over the one passed in: it is the earlier, truer
   * instant — the interrupt receipt — and the caller that arrives here later (the prompt handler's
   * `finally`, `forget` on a disconnect, the stale-turn cleanup in `beginTurn`) only knows when IT
   * noticed.
   *
   * Returns the numbers the caller needs for the call-level accumulators — including the CLAMPED
   * boundary, so the recorded span and the next `caller.turn` cannot disagree about where the turn
   * ended.
   */
  const closeLive = (
    live: LiveTurn,
    close: TurnClose,
  ): { atMs: number; ttfaMs: number | null; aborted: boolean } => {
    const effective = live.recordedClose ?? close;
    // Clamped, because `Date.now()` is not monotonic: an NTP step backwards during a call would
    // otherwise hand OpenTelemetry an end time before the start time.
    //
    // ⚠ WHAT THAT ACTUALLY PRODUCES, corrected — it is NOT a negative duration. `Span.end` in
    // `@opentelemetry/sdk-trace` computes `_duration` and, `if (this._duration[0] < 0)`, warns
    // "Inconsistent start and end time, startTime > endTime. Setting span duration to 0ms." and
    // resets `endTime` to `startTime`. So the unclamped version would export a ZERO-length turn plus
    // a `diag.warn` (invisible here, since this app registers no diag logger). The clamp is still
    // worth keeping — it keeps the recorded span end and the next `caller.turn`'s origin the same
    // number, and `turn.total_ms` below is computed from it — but do not go looking for negative
    // durations in Langfuse as the symptom of a clock step. You will find zeros.
    const atMs = Math.max(effective.atMs, live.promptAt);
    const ttfaMs = live.firstTokenAt === null ? null : Math.max(0, live.firstTokenAt - live.promptAt);

    if (live.firstTokenAt !== null) {
      // `tts.send` — from the first `text` frame to the end-of-turn marker. This is the window
      // ConversationRelay is speaking in, as far as this process can see it: `sendStreamingResponse`
      // writes each token to the socket synchronously inside its own `for await`, so our generator
      // yielding and the frame going out are the same instant to within microseconds.
      const tts = live.span.child(
        'tts.send',
        { metadata: { startedBecause: 'first text token sent' } },
        live.firstTokenAt,
      );
      tts.update({ metadata: { durationMs: atMs - live.firstTokenAt, ending: effective.ending } });
      tts.end(atMs);
    }

    live.span.update({
      metadata: {
        // The server-side proxy for time-to-first-AUDIO, and the honest name for it. It cannot see
        // Twilio's TTS synthesis or the media leg, so it is a FLOOR on what the caller waited.
        'turn.ttfa_ms': ttfaMs,
        // RE-ANCHORED over what `run-turn.ts` wrote. Its `turn.total_ms` measures the model stream
        // plus the turn preamble and stops when the stream drains; this measures `prompt` receipt to
        // end-of-turn marker, which is the window the caller experienced.
        //
        // OURS LANDS LAST BECAUSE THIS IS THE END, not because of any ordering between the two
        // writers. run-turn writes its value inside `done`; `Span.setAttribute` returns early once
        // `_isSpanEnded()`, so nothing written after the `live.span.end(atMs)` below can land at all.
        // The ordinary closer (`handleVoicePrompt`'s `finally`) has awaited `done`, so BOTH writes
        // happen — ours second. The closers that have awaited nothing (`forget` on a socket
        // disconnect, the stale-turn cleanup, eviction) end the span while a handler may still be
        // running, and everything run-turn writes afterwards is lost. That is unavoidable — an
        // unended span reaches Langfuse not at all — and it is why the interrupt path parks its
        // boundary instead of closing (see `recordBoundary`).
        'turn.total_ms': atMs - live.promptAt,
        'turn.aborted': effective.aborted,
        'turn.ending': effective.ending,
      },
    });
    live.span.end(atMs);
    return { atMs, ttfaMs, aborted: effective.aborted };
  };

  /**
   * `closeLive` plus the call-level accumulators, and the only way a turn is ever counted.
   *
   * Shared by every closer so `turns.count` cannot disagree with the number of `turn.voice` children
   * in the trace — including on the paths no handler of ours observes.
   */
  const complete = (entry: Entry, close: TurnClose): void => {
    const live = entry.live;
    if (live === null) return;
    const closed = closeLive(live, close);
    entry.live = null;
    entry.turns += 1;
    if (closed.aborted) entry.aborted += 1;
    if (closed.ttfaMs !== null) entry.ttfaMs.push(closed.ttfaMs);
    // `no-output` still moves the boundary. Nothing was spoken, but the NEXT `caller.turn` has to
    // start somewhere, and the alternative — leaving it where the previous turn ended — would
    // charge the silent turn's whole duration to the caller.
    entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, closed.atMs);
  };

  const statsOf = (entry: Entry): Record<string, unknown> => ({
    'turns.count': entry.turns,
    'turns.aborted': entry.aborted,
    // The sum of every `caller.turn` on the call: bot playback plus caller speech plus ASR
    // endpointing. Named for what the spans are named, so the number and the waterfall agree.
    'caller.turn_total_ms': entry.callerTurnMs,
    'turn.ttfa_p50_ms': p50(entry.ttfaMs),
    'turn.ttfa_max_ms': max(entry.ttfaMs),
  });

  return {
    beginTurn(conversationId, span, atMs) {
      let entry = entries.get(conversationId);
      if (entry === undefined) {
        entry = blank();
        entries.set(conversationId, entry);
      } else {
        // Re-insert so Map order is least-recently-used, matching `./conversations.ts`.
        entries.delete(conversationId);
        entries.set(conversationId, entry);
      }

      // A turn already live means the previous one never completed — a prompt handler that TAC
      // abandoned, or one still draining after its queue was dropped. End it here rather than leak
      // the span, and COUNT it: it is a real turn of this call, and the straggler's own
      // `completeTurn` will find its span is no longer the live one and do nothing.
      complete(entry, { atMs, aborted: true, ending: 'no-output' });

      entry.live = { span, promptAt: atMs, firstTokenAt: null, recordedClose: null };

      while (entries.size > maxConversations) {
        const oldest = entries.entries().next();
        if (oldest.done === true) break;
        const [id, victim] = oldest.value;
        complete(victim, { atMs, aborted: true, ending: 'evicted' });
        entries.delete(id);
        opts.logger?.warn(
          { conversationId: id, maxConversations },
          'voice timeline: evicted a conversation at the cap',
        );
      }

      const boundary = entry.lastBotOutputAt;
      // `<=` rather than `<`: a zero-length gap has nothing to draw, and a negative one is a clock
      // step. Both are honestly reported as "no prior bot output to measure from".
      if (boundary === null || boundary >= atMs) return null;
      entry.callerTurnMs += atMs - boundary;
      return boundary;
    },

    markFirstToken(conversationId, atMs, ownerSpan) {
      const live = entries.get(conversationId)?.live;
      if (live === undefined || live === null) return;
      // Not the caller's own turn: a handler that outlived its turn, stamping its successor's
      // `tts.send` start. See `completeTurn` for the measurement.
      if (ownerSpan !== undefined && live.span !== ownerSpan) return;
      // First non-empty delta only. A second call would move the `tts.send` start later, which is
      // the one number this whole module exists to get right.
      if (live.firstTokenAt === null) live.firstTokenAt = atMs;
    },

    liveTurn: (conversationId) => entries.get(conversationId)?.live?.span ?? null,

    recordBoundary(conversationId, close) {
      const entry = entries.get(conversationId);
      const live = entry?.live;
      if (entry === undefined || live === undefined || live === null) return;
      if (live.recordedClose !== null) return; // first boundary wins.
      live.recordedClose = close;
      // Moved NOW rather than when the span is closed, so a next prompt that arrives before the
      // straggling handler's `finally` still draws `caller.turn` from the interrupt.
      entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, Math.max(close.atMs, live.promptAt));
    },

    completeTurn(conversationId, close, ownerSpan) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return;
      if (entry.live === null) return; // already completed.
      if (ownerSpan !== undefined && entry.live.span !== ownerSpan) return; // not our turn any more.
      complete(entry, close);
    },

    markBotOutput(conversationId, atMs) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return;
      entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, atMs);
    },

    forget(conversationId) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return undefined;
      // BEFORE the statistics are read, which is the whole reason this returns them: a turn still
      // live when the socket closed is a real turn, and reading `turns.count` first reported zero.
      complete(entry, { atMs: Date.now(), aborted: true, ending: 'no-output' });
      const stats = statsOf(entry);
      entries.delete(conversationId);
      return stats;
    },

    size: () => entries.size,
  };
}
