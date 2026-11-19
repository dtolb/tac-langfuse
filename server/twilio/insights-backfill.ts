import { propagateAttributes } from '@langfuse/tracing';
import { childLogger } from '../logging.ts';
import { drawUnder, eventUnder, flushTelemetry } from '../obs/spans.ts';
import { insightsTurns, type InsightsClient, type RelayEvent } from './cr-insights.ts';

/** ms between a voice call ending and its one Voice Insights Events fetch. */
export const INSIGHTS_BACKFILL_DELAY_MS = 120_000;

/** Where a call's backfill draws: the call root's traceparent and the trace's session and user. */
export interface RootContext {
  readonly traceparent: string | undefined;
  readonly sessionId: string;
  readonly userId?: string | null | undefined;
}

/** What one backfill drew. */
export interface BackfillResult {
  readonly stt: number;
  readonly tts: number;
  readonly agentSpeech: number;
  readonly customerSpeech: number;
  /** `twilio.interrupt`, `twilio.call_wrap_up`, `twilio.language_changed` and `twilio.error` events. */
  readonly events: number;
  /** Whether `call_wrap_up` was among the events. */
  readonly wrappedUp: boolean;
}

const LATENCY_SPANS: Readonly<Record<string, string>> = { stt_latency: 'twilio.stt', tts_latency: 'twilio.tts' };
const EVENT_NAMES: ReadonlySet<string> = new Set(['interrupt', 'call_wrap_up', 'language_changed', 'error']);

const ids = (e: RelayEvent): Record<string, unknown> => ({ session_id: e.session, sequence_number: e.seq });

const detail = (e: RelayEvent): Record<string, unknown> => {
  const value = e.data[e.name];
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
};

/**
 * Draws a call's Voice Insights relay events under `root.traceparent` at Twilio's timestamps, inside
 * `propagateAttributes({ sessionId, userId })`. `events` must be sorted by `(session, seq)`.
 *
 * - `stt_latency` / `tts_latency`: a `twilio.stt` / `twilio.tts` span over `[at − latency_ms, at]`.
 * - `start_of_agent_speech` with the next `end_of_agent_speech` of its session: a `twilio.agent_speech` span.
 * - each `insightsTurns` turn with a caller start: a `twilio.customer_speech` span from `callerStart` to
 *   `utteranceEnd`.
 * - `interrupt`, `call_wrap_up`, `language_changed`, `error`: a zero-duration `twilio.<name>` event.
 *
 * Metadata is `session_id` and `sequence_number` (agent speech: `start_sequence_number` /
 * `end_sequence_number`), plus `latency_ms` on latency spans, `stt_latency_ms` on customer speech, and
 * an event's own detail fields.
 */
export function drawInsights(events: readonly RelayEvent[], root: RootContext): BackfillResult {
  const tp = root.traceparent;
  const counts = { stt: 0, tts: 0, agentSpeech: 0, customerSpeech: 0, events: 0 };
  let wrappedUp = false;

  propagateAttributes({ sessionId: root.sessionId, ...(root.userId ? { userId: root.userId } : {}) }, () => {
    const openAgent = new Map<string, RelayEvent>();
    for (const e of events) {
      const latencySpan = LATENCY_SPANS[e.name];
      if (latencySpan !== undefined) {
        const latencyMs = detail(e).latency_ms;
        if (typeof latencyMs !== 'number') continue;
        drawUnder(tp, latencySpan, { metadata: { ...ids(e), latency_ms: latencyMs } }, e.at - latencyMs, e.at);
        counts[e.name === 'stt_latency' ? 'stt' : 'tts'] += 1;
      } else if (e.name === 'start_of_agent_speech') {
        openAgent.set(e.session, e);
      } else if (e.name === 'end_of_agent_speech') {
        const start = openAgent.get(e.session);
        if (start === undefined) continue;
        openAgent.delete(e.session);
        const metadata = { session_id: e.session, start_sequence_number: start.seq, end_sequence_number: e.seq };
        drawUnder(tp, 'twilio.agent_speech', { metadata }, start.at, e.at);
        counts.agentSpeech += 1;
      } else if (EVENT_NAMES.has(e.name)) {
        eventUnder(tp, `twilio.${e.name}`, { metadata: { ...ids(e), ...detail(e) } }, e.at);
        counts.events += 1;
        if (e.name === 'call_wrap_up') wrappedUp = true;
      }
    }

    for (const turn of insightsTurns(events).turns) {
      if (turn.callerStart === null) continue;
      const metadata = { session_id: turn.session, sequence_number: turn.callerStartSeq, stt_latency_ms: turn.sttMs };
      drawUnder(tp, 'twilio.customer_speech', { metadata }, turn.callerStart, turn.utteranceEnd);
      counts.customerSpeech += 1;
    }
  });

  return { ...counts, wrappedUp };
}

/** Schedules the post-call Voice Insights backfill. */
export interface InsightsBackfill {
  /**
   * Fetches `callSid`'s Voice Insights Events once after the delay and draws them under `root`. Resolves
   * with what was drawn, or `null` when the fetch failed.
   */
  callEnded(callSid: string, root: RootContext): Promise<BackfillResult | null>;
}

/** Logger levels the backfill uses. */
export interface BackfillLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** Creates the backfill. `delayMs` defaults to `INSIGHTS_BACKFILL_DELAY_MS`. */
export function createInsightsBackfill(opts: {
  readonly insights: InsightsClient;
  readonly delayMs?: number;
  readonly logger?: BackfillLogger;
}): InsightsBackfill {
  const delayMs = opts.delayMs ?? INSIGHTS_BACKFILL_DELAY_MS;
  const log = opts.logger ?? childLogger('insights-backfill');
  return {
    callEnded: (callSid, root) =>
      new Promise((resolve) => {
        setTimeout(() => {
          void (async () => {
            try {
              const { events } = await opts.insights.fetch(callSid);
              const result = drawInsights(events, root);
              await flushTelemetry();
              log.info(
                { callSid, conversationId: root.sessionId, relayEvents: events.length, ...result },
                `voice insights backfill: ${result.stt} stt, ${result.tts} tts, ${result.agentSpeech} agent speech, ${result.customerSpeech} customer speech, ${result.events} events${result.wrappedUp ? '' : ' (no call_wrap_up yet)'}`,
              );
              resolve(result);
            } catch (err) {
              log.warn({ err, callSid }, 'voice insights backfill failed');
              resolve(null);
            }
          })();
        }, delayMs).unref();
      }),
  };
}
