/**
 * The handoff contract shared by the server, the Studio flow definition and the softphone page.
 *
 * `shared/` is compiled by BOTH tsconfig projects, so nothing here may touch a Node or DOM global.
 * Everything below is pure data or a type.
 */

/**
 * The Voice SDK identity the softphone registers as, and the identity the Studio flow dials.
 *
 * NO HYPHEN, and that is the whole reason this is a constant rather than a literal in three places.
 * The Voice JS SDK documents the token identity as "may only contain alpha-numeric and underscore
 * characters". The orphan flow published on this account dials `client:browser-agent`, which is
 * outside that set — whether it works is undocumented and untested. The flow is an orphan (no phone
 * number references it), so changing it costs nothing and removes an undocumented dependency.
 */
export const CLIENT_IDENTITY = 'browser_agent';

/**
 * The `<Connect action>` URL. OURS, not TAC's `/conversation-relay-callback`.
 *
 * TAC's route answers `text/plain "OK"` and its payload schema has no `HandoffData` field, so it
 * STRIPS the handoff and then ends the call. Pinning this path in `defaultTwimlOptions` is what makes
 * the handoff reachable at all — see the design doc §2.1.
 *
 * Under `/api/` deliberately: `APP_API_PATHS` already covers that prefix, so the Traefik router rules
 * and `tests/architecture.test.ts` need no change.
 */
export const VOICE_ACTION_PATH = '/api/voice/relay-action';

/** Mints a Voice SDK AccessToken for `CLIENT_IDENTITY`. POST, because it is a credential. */
export const VOICE_TOKEN_PATH = '/api/voice/token';

/** The screen pop: what the human agent sees before they say hello. */
export const HANDOFF_CONTEXT_PATH = '/api/handoff/context';

/**
 * AccessToken lifetime. One hour, which is Twilio's own default.
 *
 * Lives in `shared/` because both sides need it and neither may import the other's: the minter is in
 * `server/twilio/` (it imports the `twilio` package) and the route that reports it is in `server/http/`
 * (which may not). Two hard-coded 3600s would drift the moment one was tuned.
 *
 * The page re-fetches on `tokenWillExpire` regardless, because a token that expires mid-demo takes the
 * softphone offline silently — the Device stops registering and nothing on screen says why.
 */
export const VOICE_TOKEN_TTL_SECONDS = 3600;

/**
 * How confidently the screen pop was matched to the ringing call.
 *
 * Reported to the UI rather than hidden, because the two weak cases are real: Studio's
 * `connect-call-to` widget cannot pass parameters to a client, and dialling a client mints a NEW call
 * leg with a NEW CallSid, so `call.parameters.CallSid` in the browser can never match the inbound
 * call. See the design doc §3.2.
 *
 *  - `exact`  — matched on `conversationId`, carried as a `<Parameter>` on the direct-Dial path.
 *  - `caller` — matched on the caller's number, which Studio preserves via `caller_id`.
 *  - `recent` — fell back to the most recent snapshot. Correct in a demo, wrong under load.
 *  - `none`   — no snapshot at all; the pop shows the number and nothing else.
 */
export type HandoffMatch = 'exact' | 'caller' | 'recent' | 'none';

/**
 * NARROWER than `TurnMessage.role` in `server/agent/types.ts`, which is
 * `'system' | 'user' | 'assistant'`. Deliberate, for two independent reasons:
 *
 *  - `shared/` may not import from `server/`, so this cannot be the same union by construction.
 *  - A screen pop is read by a HUMAN agent mid-call. `'system'` turns are the compiled prompt, and
 *    leaking prompt text onto an agent's screen is both a bad demo and a disclosure we never intended.
 *    Narrowing the type makes the drain drop those turns rather than trusting it to remember.
 */
export interface HandoffTranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface HandoffContextResponse {
  readonly found: boolean;
  readonly match: HandoffMatch;
  /** The model's own words for why it transferred. `null` when `found` is false. */
  readonly reason: string | null;
  readonly conversationId: string | null;
  /** MASKED for display. The verbatim number is never sent to the browser. */
  readonly maskedFrom: string | null;
  /** ISO 8601, so the UI can say how stale the snapshot is. */
  readonly at: string | null;
  /**
   * Verbatim, and deliberately NOT scrubbed. `server/obs/pii.ts` scrubs log lines and obs payloads;
   * the human agent needs the real words the caller said. This is a new PII surface and the design
   * doc §10 states it rather than hiding it.
   */
  readonly transcript: readonly HandoffTranscriptTurn[];
}
