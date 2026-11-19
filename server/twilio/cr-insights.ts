const INSIGHTS_BASE = 'https://insights.twilio.com/v1/Voice';

/** One `conversation_relay` row of Voice Insights Events. `at` is epoch ms. */
export interface RelayEvent {
  readonly name: string;
  readonly at: number;
  readonly session: string;
  readonly seq: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The parts of a Voice Insights call this agent reads. */
export interface InsightsCall {
  /** Sorted by `(session, seq)`. */
  readonly events: readonly RelayEvent[];
  /** `agent_session_summaries[0]` of the call Summary, or `null` while it is not available. */
  readonly summary: Readonly<Record<string, unknown>> | null;
}

/** Fetches Voice Insights for a call. */
export interface InsightsClient {
  /**
   * Returns every `conversation_relay` event and the Summary; no events and no Summary while Voice Insights
   * answers 404 for the call. Throws on any other non-2xx Events response.
   */
  fetch(callSid: string): Promise<InsightsCall>;
}

interface RawEvent {
  readonly name: string;
  readonly group: string;
  readonly timestamp: string;
  readonly conversation_relay_data?: Record<string, unknown> | null;
}

/**
 * Creates a client that reads `/v1/Voice/{CallSid}/Events` (carrier edge, following `meta.next_page_url`)
 * and `/v1/Voice/{CallSid}/Summary` with API-key basic auth.
 */
export function createInsightsClient(creds: { readonly apiKey: string; readonly apiSecret: string }): InsightsClient {
  const headers = { authorization: `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64')}` };
  return {
    async fetch(callSid) {
      const raw: RawEvent[] = [];
      let url: string | null = `${INSIGHTS_BASE}/${callSid}/Events?Edge=carrier_edge&PageSize=1000`;
      while (url !== null) {
        const res = await fetch(url, { headers });
        if (res.status === 404) return { events: [], summary: null };
        if (!res.ok) throw new Error(`Voice Insights Events ${res.status}`);
        const page = (await res.json()) as { events?: RawEvent[]; meta?: { next_page_url?: string | null } };
        raw.push(...(page.events ?? []));
        url = page.meta?.next_page_url ?? null;
      }
      const summaryRes = await fetch(`${INSIGHTS_BASE}/${callSid}/Summary`, { headers });
      const summaryBody = summaryRes.ok
        ? ((await summaryRes.json()) as { agent_session_summaries?: Record<string, unknown>[] | null })
        : null;
      return { events: relayEvents(raw), summary: summaryBody?.agent_session_summaries?.[0] ?? null };
    },
  };
}

/** Keeps the `conversation_relay` rows of an Events response and sorts them by `(session_id, sequence_number)`. */
export function relayEvents(raw: readonly RawEvent[]): RelayEvent[] {
  return raw
    .filter((e) => e.group === 'conversation_relay')
    .map((e) => {
      const data = e.conversation_relay_data ?? {};
      return {
        name: e.name,
        at: Date.parse(e.timestamp),
        session: String(data.session_id ?? ''),
        seq: Number(data.sequence_number ?? 0),
        data,
      };
    })
    .sort((a, b) => (a.session === b.session ? a.seq - b.seq : a.session < b.session ? -1 : 1));
}

/** One turn as Voice Insights reports it, anchored on `prompt_sent`. Epoch ms. */
export interface InsightsTurn {
  /** `start_of_customer_speech` that opened the turn, or `null` when it is not real. */
  readonly callerStart: number | null;
  /** `sequence_number` of the `start_of_customer_speech` in `callerStart`, or `null` with it. */
  readonly callerStartSeq: number | null;
  /** `session_id` of the turn's `prompt_sent`. */
  readonly session: string;
  /** `t(end_of_customer_speech) − stt_latency.latency_ms`. */
  readonly utteranceEnd: number;
  readonly sttMs: number | null;
  readonly promptSent: number;
  readonly firstToken: number | null;
  readonly audioStart: number | null;
  readonly audioEnd: number | null;
  readonly interrupted: boolean;
}

/** The turns of one call, plus the welcome greeting's end and whether the session has wrapped up. */
export interface InsightsTurns {
  readonly turns: readonly InsightsTurn[];
  readonly greetingEnd: number | null;
  readonly wrappedUp: boolean;
}

const latency = (e: RelayEvent, key: string): number | null => {
  const v = (e.data[key] as { latency_ms?: unknown } | undefined)?.latency_ms;
  return typeof v === 'number' ? v : null;
};

/**
 * Segments sorted relay events into turns, one per `prompt_sent`.
 *
 * A turn's caller speech opens at the first `start_of_customer_speech` after the previous `prompt_sent`; the
 * STT latency and end of speech are the last ones before its `prompt_sent`; first token, agent audio start
 * and end are the first ones after it, in that order. A turn is interrupted when an `interrupt` lands between
 * 50 ms before and 500 ms after its audio end.
 */
export function insightsTurns(events: readonly RelayEvent[]): InsightsTurns {
  const turns: {
    callerStart: number | null;
    callerStartSeq: number | null;
    session: string;
    utteranceEnd: number;
    sttMs: number | null;
    promptSent: number;
    firstToken: number | null;
    audioStart: number | null;
    audioEnd: number | null;
  }[] = [];
  const interrupts: number[] = [];
  let openStart: number | null = null;
  let openStartSeq: number | null = null;
  let lastEnd: number | null = null;
  let lastStt: number | null = null;
  let greetingEnd: number | null = null;
  let wrappedUp = false;

  for (const e of events) {
    const current = turns.at(-1);
    switch (e.name) {
      case 'start_of_customer_speech':
        if (openStart === null) {
          openStart = e.at;
          openStartSeq = e.seq;
        }
        break;
      case 'stt_latency':
        lastStt = latency(e, 'stt_latency');
        break;
      case 'end_of_customer_speech':
        lastEnd = e.at;
        break;
      case 'prompt_sent': {
        const end = lastEnd ?? e.at;
        const utteranceEnd = end - (lastStt ?? 0);
        const callerStart = openStart !== null && openStart < end ? openStart : null;
        const callerStartSeq = callerStart === null ? null : openStartSeq;
        turns.push({ callerStart, callerStartSeq, session: e.session, utteranceEnd, sttMs: lastStt, promptSent: e.at, firstToken: null, audioStart: null, audioEnd: null });
        openStart = null;
        openStartSeq = null;
        lastEnd = null;
        lastStt = null;
        break;
      }
      case 'first_token_received':
        if (current !== undefined && current.firstToken === null) current.firstToken = e.at;
        break;
      case 'start_of_agent_speech':
        if (current !== undefined && current.firstToken !== null && current.audioStart === null) current.audioStart = e.at;
        break;
      case 'end_of_agent_speech':
        if (current === undefined) greetingEnd ??= e.at;
        else if (current.audioStart !== null && current.audioEnd === null) current.audioEnd = e.at;
        break;
      case 'interrupt':
        interrupts.push(e.at);
        break;
      case 'call_wrap_up':
        wrappedUp = true;
        break;
    }
  }

  return {
    turns: turns.map((t) => ({
      ...t,
      interrupted: t.audioEnd !== null && interrupts.some((i) => i >= (t.audioEnd as number) - 50 && i <= (t.audioEnd as number) + 500),
    })),
    greetingEnd,
    wrappedUp,
  };
}
