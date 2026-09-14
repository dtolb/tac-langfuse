/**
 * `POST /api/voice/relay-action` — the `<Connect action>` URL, and the one place the call is routed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS ROUTE RETURNS VALID TwiML ON EVERY PATH, INCLUDING THE ONES THAT ARE BUGS.
 *
 * A throw here is a dropped call plus a TwiML error in the Twilio debugger — the caller hears silence
 * and nothing says why. So unparseable `HandoffData` answers `<Hangup/>` with a loud log rather than a
 * 500, and a half-configured account falls back to a path that works rather than emitting a URL Twilio
 * will 404.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS ROUTE EXISTS AT ALL, rather than pointing `actionUrl` at Studio or leaving TAC's default:
 * TAC's `/conversation-relay-callback` is TAC's OWN route, it answers `text/plain "OK"` and never
 * TwiML, and its payload schema has no `HandoffData` field — being a plain non-strict `z.object` it
 * STRIPS it. So the handoff would arrive and be silently discarded. Design doc §2.1.
 *
 * NO TWILIO SIGNATURE VALIDATION, stated rather than hidden. Validation needs `validateRequest` from
 * the `twilio` package, which `tests/architecture.test.ts` confines to `server/twilio/`. The exposure
 * is small and worth naming precisely: an unauthenticated POST here returns routing TwiML and nothing
 * else — no account data, no token, no side effect beyond one obs event. It cannot place a call; only
 * Twilio executing TwiML for a call that already reached us can. If this ever needs signing, inject a
 * validator from `server/twilio/` the way `./routes-handoff.ts` has `mintToken` injected into it.
 */
import { z } from 'zod';
import { CLIENT_IDENTITY, VOICE_ACTION_PATH } from '../../shared/handoff.ts';
import type { AppConfig, Capabilities } from '../config.ts';
import { childLogger } from '../logging.ts';
import type { ObsBus } from '../obs/bus.ts';
import { maskPhone } from '../obs/pii.ts';
import type { App } from './types.ts';

const log = childLogger('voice-action');

/** How long to ring the browser before giving up. Twilio's default is 30 s; stated so it is tunable. */
const DIAL_TIMEOUT_SECONDS = 30;

/**
 * Non-strict on purpose: Twilio adds fields to this callback over time (`ApplicationSid` and
 * `SessionDuration` were not in the first version of the docs), and a `.strict()` schema would turn a
 * Twilio addition into a dropped call. Every field is optional because the three documented payload
 * shapes — ended, completed, failed — each omit some of them.
 */
const ActionBody = z.object({
  CallSid: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  CallStatus: z.string().optional(),
  SessionStatus: z.string().optional(),
  SessionDuration: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
  /** A JSON-encoded STRING, per Twilio. The double encoding is the documented contract, not a defect. */
  HandoffData: z.string().optional(),
});

/** XML-escape a value going into an attribute or a text node. */
const xml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const hangup = (): string => `${DECLARATION}<Response><Hangup/></Response>`;

/**
 * The Studio voice webhook URL.
 *
 * Written out rather than imported from TAC's `studioVoiceHandoffUrl(accountSid, flowSid)` — which
 * produces this exact string — because this module may not import `twilio-agent-connect`. Kept
 * byte-identical, and `tests/voice-action.test.ts` pins it, so a TAC change to the shape is a visible
 * test failure rather than a silent divergence.
 *
 * `Trigger=incomingCall` is what makes Studio start a voice execution. Note the flow receives NO
 * handoff data: a `<Redirect>` starts a FRESH incoming-call execution, whose trigger variables are the
 * fixed Call-resource set, so a custom query parameter would not resolve. The screen pop gets its data
 * from `GET /api/handoff/context` instead — see the plan's correction C7.
 */
const studioUrl = (accountSid: string, flowSid: string): string =>
  `https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${flowSid}?Trigger=incomingCall`;

/**
 * Dial the browser client directly — the zero-Studio-setup path, so a fresh clone works with no
 * account configuration beyond the softphone being open.
 *
 * `answerOnBridge="true"` so the caller keeps hearing ringing until the human actually answers, rather
 * than going silent the moment Twilio starts dialling.
 *
 * `<Parameter>` inside `<Client>` is what the Voice SDK surfaces as `call.customParameters`, and it is
 * the ONLY exact correlator available anywhere in this feature. `<Hangup/>` after `</Dial>` covers the
 * no-answer case: without it, a timed-out dial falls off the end of the document and the caller sits
 * on an open line.
 */
const dialClient = (conversationId: string | null): string =>
  `${DECLARATION}<Response>` +
  `<Dial answerOnBridge="true" timeout="${DIAL_TIMEOUT_SECONDS}">` +
  `<Client><Identity>${xml(CLIENT_IDENTITY)}</Identity>` +
  (conversationId === null ? '' : `<Parameter name="conversationId" value="${xml(conversationId)}"/>`) +
  `</Client></Dial><Hangup/></Response>`;

export interface ActionTwimlResult {
  readonly twiml: string;
  readonly route: 'studio' | 'client' | 'hangup';
  readonly conversationId: string | null;
  readonly reasonCode: string | null;
}

/**
 * The whole decision, as a pure function, so every branch is testable without a socket.
 *
 * Exported for that reason alone — the route handler below is a thin wrapper that parses, calls this,
 * publishes and replies.
 */
export function buildActionTwiml(input: {
  readonly handoffData: string | undefined;
  readonly accountSid: string | null;
  readonly flowSid: string | null;
}): ActionTwimlResult {
  if (input.handoffData === undefined || input.handoffData === '') {
    /**
     * The `end_call` path, and a DELIBERATE BEHAVIOUR CHANGE. Today TAC answers this callback with
     * `text/plain "OK"`, Twilio gets nothing actionable and drops the call; `docs/HANDOFF.md` records
     * that no alert is raised and says not to "fix" it. Owning the route makes returning TwiML
     * unavoidable, and `<Hangup/>` is the cleaner disposition — but it IS a change on a working path
     * and the verification ladder re-tests the plain hangup because of it.
     */
    return { twiml: hangup(), route: 'hangup', conversationId: null, reasonCode: null };
  }

  let payload: { conversationId?: unknown; attributes?: { reasonCode?: unknown } };
  try {
    payload = JSON.parse(input.handoffData) as typeof payload;
  } catch {
    // Loud, because it means the frame and this parser disagree — a code bug, not a caller action.
    log.error(
      { handoffDataLength: input.handoffData.length },
      'voice-action: HandoffData was not valid JSON, so the call is being hung up rather than routed',
    );
    return { twiml: hangup(), route: 'hangup', conversationId: null, reasonCode: null };
  }

  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
  const reasonCode = typeof payload.attributes?.reasonCode === 'string' ? payload.attributes.reasonCode : null;

  // Both halves required, or the URL is `Accounts/null/Flows/...` — a Twilio 404 the caller experiences
  // as silence. Falling back to the client path is strictly better than emitting a broken redirect.
  if (input.flowSid !== null && input.accountSid !== null) {
    return {
      twiml: `${DECLARATION}<Response><Redirect method="POST">${xml(studioUrl(input.accountSid, input.flowSid))}</Redirect></Response>`,
      route: 'studio',
      conversationId,
      reasonCode,
    };
  }

  return { twiml: dialClient(conversationId), route: 'client', conversationId, reasonCode };
}

export function registerVoiceActionRoutes(
  app: App,
  deps: { readonly config: AppConfig; readonly caps: Capabilities; readonly bus: ObsBus },
): void {
  /**
   * NO CAPABILITY GATE, unlike every other route in this directory. Twilio is already executing TwiML
   * for a live call by the time it reaches here; answering 503 would drop that call. The capability
   * question — is a Studio flow configured? — is a ROUTING decision, not an availability one, and
   * `buildActionTwiml` makes it.
   */
  app.post(VOICE_ACTION_PATH, (request, reply) => {
    const parsed = ActionBody.safeParse(request.body ?? {});
    const body = parsed.success ? parsed.data : {};
    if (!parsed.success) {
      // Cannot happen with every field optional, but a schema edit could make it possible, and the
      // consequence would be a dropped call. Logged rather than thrown.
      log.warn({ url: request.url }, 'voice-action: could not parse the action callback body');
    }

    if (body.SessionStatus === 'failed') {
      // ConversationRelay itself failed — 64105 "WebSocket Ended" is the common one. There is nothing
      // to route to, and the error codes are the only diagnosis available for a call the caller
      // experienced as a dropped line.
      log.error(
        { errorCode: body.ErrorCode ?? null, errorMessage: body.ErrorMessage ?? null, callSid: body.CallSid ?? null },
        'voice-action: the ConversationRelay session FAILED, so the call is being hung up',
      );
      deps.bus.publish({
        kind: 'error',
        summary: `ConversationRelay session failed: ${body.ErrorCode ?? '?'} ${body.ErrorMessage ?? ''}`.trim(),
        channel: 'voice',
        payload: { errorCode: body.ErrorCode ?? null, errorMessage: body.ErrorMessage ?? null },
      });
      void reply.code(200).type('text/xml').send(hangup());
      return;
    }

    const result = buildActionTwiml({
      handoffData: body.HandoffData,
      accountSid: deps.config.twilio?.accountSid ?? null,
      flowSid: deps.config.studioHandoffFlowSid,
    });

    if (result.route !== 'hangup') {
      deps.bus.publish({
        kind: 'handoff',
        // `summary` is copied VERBATIM by the bus — only `payload` is scrubbed — so the number is
        // masked here, the same rule `./app.ts` and `../twilio/messaging.ts` follow.
        summary: `routing the transferred call to ${result.route} for ${maskPhone(body.From ?? 'unknown')}`,
        channel: 'voice',
        ...(result.conversationId !== null && { conversationId: result.conversationId }),
        payload: {
          route: result.route,
          reasonCode: result.reasonCode,
          sessionStatus: body.SessionStatus ?? null,
          sessionDurationSeconds: body.SessionDuration ?? null,
          callSid: body.CallSid ?? null,
          from: body.From ?? null,
          identity: result.route === 'client' ? CLIENT_IDENTITY : null,
        },
      });
    }

    /**
     * `text/xml`, not `application/xml`. Both work, and Twilio's own examples use `text/xml` — the
     * value matters only because a JSON content type makes Twilio report a TwiML parse error rather
     * than executing the document.
     */
    void reply.code(200).type('text/xml').send(result.twiml);
  });
}
