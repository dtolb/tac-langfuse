import type { ConfigFrame, Preset, Profile, Timing } from './cr-params.ts';

/** `GET` returns `TuningState`. */
export const TUNING_PATH = '/api/tuning';

/** `POST` an `ApplyRequest`, returns `ApplyResponse`. */
export const TUNING_APPLY_PATH = '/api/tuning/apply';

/** Fastify route pattern for `PUT` a `SavePresetRequest`, returns `SavePresetResponse`. */
export const TUNING_PRESET_ROUTE = '/api/tuning/presets/:name';

/** `GET` returns `CallsResponse`. */
export const CALLS_PATH = '/api/calls';

/** Fastify route pattern for `GET` a call's `CallTimeline`. */
export const CALL_TIMELINE_ROUTE = '/api/calls/:callSid/timeline';

/** Returns the `PUT` URL for the preset called `name`. */
export const tuningPresetPath = (name: string): string => `/api/tuning/presets/${encodeURIComponent(name)}`;

/** Returns the `GET` URL for the timeline of call `callSid`. */
export const callTimelinePath = (callSid: string): string => `/api/calls/${encodeURIComponent(callSid)}/timeline`;

/** Body of any non-2xx response from these routes. */
export interface ApiError {
  readonly error: string;
}

/** One call as listed in tabs. `from` is masked; `elapsedS` is measured at response time. */
export interface CallSummary {
  readonly sid: string;
  readonly from: string;
  readonly live: boolean;
  /** ISO 8601. */
  readonly startedAt: string;
  /** ISO 8601, or `null` while live. */
  readonly endedAt: string | null;
  readonly elapsedS: number;
  /** Profile revision in force when the call started. */
  readonly startRev: number;
  /** True while any Apply sent to this call has a change with `effectiveAt === null`. */
  readonly applying: boolean;
}

/** A live call as `GET /api/tuning` reports it. */
export interface LiveCall extends CallSummary {
  readonly conversationId: string;
  /** Latest profile revision sent to this call. */
  readonly rev: number;
  /** The call's current config: its starting profile overlaid with every `configUpdated` delta received. */
  readonly effective: Profile;
}

/** `GET /api/tuning`. */
export interface TuningState {
  readonly profile: Profile;
  readonly rev: number;
  /** Where the live profile came from, e.g. `from Fast turns — Deepgram flux, 2 edits`. */
  readonly source: string;
  readonly presets: readonly Preset[];
  readonly liveCalls: readonly LiveCall[];
}

/** `POST /api/tuning/apply` body. */
export interface ApplyRequest {
  /** The full staged profile; the server diffs it against the saved one. */
  readonly profile: Profile;
  /** The preset that staged the changes, if any. */
  readonly preset?: string | null;
}

/** One changed key of an Apply. */
export interface ProfileChange {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly timing: Timing;
}

/** What one live call received from an Apply. */
export interface ApplyCallResult {
  readonly sid: string;
  readonly conversationId: string;
  /** The exact frame sent, or `null` when the Apply had no live-applicable keys. */
  readonly frame: ConfigFrame | null;
  readonly sent: boolean;
  readonly error: string | null;
}

/** `POST /api/tuning/apply` response. */
export interface ApplyResponse {
  readonly rev: number;
  readonly applyId: string;
  readonly source: string;
  readonly changes: readonly ProfileChange[];
  /** Changed keys that only take effect on the next call. */
  readonly nextCall: readonly string[];
  readonly calls: readonly ApplyCallResult[];
}

/** `PUT /api/tuning/presets/:name` body. */
export interface SavePresetRequest {
  readonly values: Profile;
}

/** `PUT /api/tuning/presets/:name` response. */
export interface SavePresetResponse {
  readonly presets: readonly Preset[];
}

/** `GET /api/calls`: live calls first, then recently ended, each group newest first. */
export interface CallsResponse {
  readonly calls: readonly CallSummary[];
}

/**
 * One caller turn and the agent reply it produced, in ms from call start.
 *
 * `sttEnd` (prompt receipt) and `firstToken` are this agent's own measurements. `callerStart`,
 * `utteranceEnd`, `audioStart` and `audioEnd` come from Voice Insights and are estimates while
 * `insights` is false.
 */
export interface Turn {
  readonly n: number;
  readonly callerStart: number;
  readonly utteranceEnd: number;
  readonly sttEnd: number;
  readonly firstToken: number;
  readonly audioStart: number;
  readonly audioEnd: number;
  readonly interrupted: boolean;
  /** Profile revision the turn ran under, or `a→b` when an Apply landed inside it. */
  readonly rev: string;
  /** True once Voice Insights has filled this turn's caller, STT, TTS and audio stages. */
  readonly insights: boolean;
}

/** One key of an Apply on one call; `effectiveAt` and `firstTurn` stay `null` until `configUpdated` reports it. */
export interface ConfigChange extends ProfileChange {
  /** ms from call start. */
  readonly effectiveAt: number | null;
  readonly firstTurn: number | null;
}

/** One Apply as it reached one call. */
export interface Apply {
  readonly applyId: string;
  readonly rev: number;
  /** Local wall-clock time of the send, `HH:MM:SS`. */
  readonly wall: string;
  /** ms from call start. */
  readonly at: number;
  readonly preset: string | null;
  readonly changes: readonly ConfigChange[];
  readonly nextCall: readonly string[];
}

/** How much of a call Voice Insights has backfilled. */
export type InsightsStatus = 'pending' | 'partial' | 'complete';

/** `GET /api/calls/:callSid/timeline`. */
export interface CallTimeline extends CallSummary {
  /** ms from call start to the end of the welcome greeting; an estimate until Voice Insights fills it. */
  readonly greetingEnd: number;
  readonly durationMs: number;
  readonly turns: readonly Turn[];
  readonly applies: readonly Apply[];
  readonly insights: InsightsStatus;
  /** One line describing where each lane's data came from. */
  readonly insightsNote: string;
}

/** `payload` of a `cr.config.apply` obs event. */
export interface CrConfigApplyPayload {
  readonly callSid: string;
  readonly applyId: string;
  readonly rev: number;
  readonly changes: readonly ProfileChange[];
  readonly frame: ConfigFrame;
}

/** `payload` of a `cr.config.updated` obs event. */
export interface CrConfigUpdatedPayload {
  readonly callSid: string;
  /** The `configUpdated` delta as Twilio sent it; values are strings. */
  readonly delta: Readonly<Record<string, unknown>>;
  readonly applyId: string | null;
  readonly sinceApplyMs: number | null;
  /** True for the session-start events that record the call's starting config. */
  readonly initial: boolean;
}

/** `payload` of a `cr.config.error` obs event. */
export interface CrConfigErrorPayload {
  readonly callSid: string;
  readonly description: string;
  readonly applyId: string | null;
}
