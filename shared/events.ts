/**
 * The observability event vocabulary — the contract between the agent and the console.
 *
 * Lives in shared/ because the browser needs the kind list to build its filter UI, and a
 * hand-maintained copy on the client would drift the moment someone adds a kind. Pure data:
 * no Node global, no DOM global.
 *
 * A CLOSED tuple, not an open string, so `ObsEventKind` is a real union and a typo in a
 * publish call is a compile error rather than an event nobody ever sees.
 *
 * Division of labour, worth stating once: these events are LIVE and EPHEMERAL — they exist to
 * drive the console during a demo and to fill the dead air on a phone call. Langfuse is the
 * durable, analytical record. That is why there is no database behind this.
 */

export const OBS_EVENT_KINDS = [
  // --- a turn, end to end ---
  'turn.start',
  'turn.end',

  // --- the measurable steps inside a turn ---
  'prompt.fetch',
  'memory.recall',
  'tool.selection',
  'tool.execution',
  'tool.unavailable',
  'llm.request',
  'llm.first_token',
  'llm.response',

  // --- Twilio-side traffic ---
  'webhook.inbound',
  'voice.setup',
  'voice.transcript',
  'voice.interrupt',
  'voice.disconnect',
  'sms.inbound',
  'sms.outbound',
  'handoff',

  // --- anything that went wrong ---
  'error',
] as const;

export type ObsEventKind = (typeof OBS_EVENT_KINDS)[number];

/** Which surface a turn arrived on. `bench` is the Twilio-free harness. */
export const OBS_CHANNELS = ['voice', 'sms', 'bench'] as const;
export type ObsChannel = (typeof OBS_CHANNELS)[number];

/**
 * What a publisher supplies.
 *
 * `summary` and `payload` are deliberately separate: the console renders one line per event
 * in a live list, and putting a full JSON blob there makes the list unreadable during the
 * exact 60 seconds it needs to be readable. `payload` is for the detail view.
 */
export interface ObsEventInput {
  readonly kind: ObsEventKind;
  /** One short line, already human-readable. No JSON. */
  readonly summary: string;
  readonly channel?: ObsChannel;
  readonly conversationId?: string;
  /** Ties a request event to its matching response event. */
  readonly correlationId?: string;
  /** Wall-clock duration, where the event represents something that took time. */
  readonly durationMs?: number;
  /** Full detail for the drawer. Scrubbed before it leaves the process. */
  readonly payload?: Record<string, unknown>;
}

/** What subscribers receive: the input plus identity and ordering. */
export interface ObsEvent extends ObsEventInput {
  readonly id: number;
  /** ISO 8601, so a value pasted into a bug report is readable without conversion. */
  readonly at: string;
}

/**
 * Colour grouping for the console. Kept next to the kinds so adding a kind without deciding
 * its colour is a compile error (the Record is exhaustive) rather than an invisible default.
 */
export const KIND_TONE: Record<ObsEventKind, 'neutral' | 'accent' | 'success' | 'warning' | 'error'> = {
  'turn.start': 'accent',
  'turn.end': 'success',
  'prompt.fetch': 'neutral',
  'memory.recall': 'neutral',
  'tool.selection': 'neutral',
  'tool.execution': 'accent',
  'tool.unavailable': 'warning',
  'llm.request': 'neutral',
  'llm.first_token': 'accent',
  'llm.response': 'success',
  'webhook.inbound': 'neutral',
  'voice.setup': 'accent',
  'voice.transcript': 'neutral',
  'voice.interrupt': 'warning',
  'voice.disconnect': 'neutral',
  'sms.inbound': 'neutral',
  'sms.outbound': 'success',
  handoff: 'warning',
  error: 'error',
};

/** How long the console's live buffer keeps events for a browser that joins mid-call. */
export const OBS_RING_BUFFER_SIZE = 500;

/** SSE keep-alive interval. Comfortably under typical 30-60s proxy idle timeouts. */
export const SSE_HEARTBEAT_MS = 15_000;
