/**
 * The Studio flow that answers a transferred call, as data in the repo.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS TWO WIDGETS, AND IT RECEIVES NO HANDOFF DATA.
 *
 * The design doc (§8) specified a `set-variables` widget reading `{{trigger.call.HandoffData}}` typed
 * `json_object`, and called that type the load-bearing detail. That is correct when STUDIO ITSELF is
 * the `<Connect action>` URL — ConversationRelay posts `HandoffData` in the body and Studio surfaces it
 * on the trigger. But this repo must own the action route (TAC's own route strips `HandoffData` and
 * answers text/plain), so Studio is reached by a `<Redirect>`, which starts a FRESH incoming-call
 * execution. Twilio documents the Incoming Call trigger's variables as a FIXED set — the Call resource
 * fields — so a custom query parameter would silently resolve to nothing.
 *
 * The flow therefore does not need it. Everything the human agent sees comes from
 * `GET /api/handoff/context`, correlated on the caller's number, which is the mechanism the design
 * already required anyway: the `connect-call-to` widget cannot pass parameters to a client, and dialling
 * a client mints a new call leg with a new CallSid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A COMMITTED DEFINITION AT ALL, rather than clicking it in the Console: the same reason
 * `scripts/knowledge-articles.ts` exists. A flow that lives only in one Twilio account cannot be handed
 * to anybody, and this repo is cloned per demo. The Console remains the place to EDIT it; this is the
 * place it comes from.
 */
import { CLIENT_IDENTITY } from '../shared/handoff.ts';

export const STUDIO_FLOW_FRIENDLY_NAME = 'demo-scaffold-human-handoff';

/**
 * `caller_id: {{contact.channel.address}}` is the load-bearing line.
 *
 * It preserves the ORIGINAL caller's number on the leg dialled to the browser, which is the only
 * correlator the screen pop has on this path. Replace it with a Twilio number and the pop degrades from
 * a `caller` match to a `recent` one — still functional, but wrong under any concurrency.
 *
 * `noun: 'client'` with `to: CLIENT_IDENTITY` is the Voice SDK identity form. The identity is imported
 * rather than written out because the token route, this flow and the page must agree, and it must
 * contain NO HYPHEN — the Voice SDK documents the identity charset as alphanumerics and underscores,
 * and the flow previously published on this account dialled `client:browser-agent`, which is outside it.
 *
 * `timeout: 30` bounds the ring. Both transitions are terminal (`next: null`): there is no voicemail
 * fallback and no second attempt, which the design doc lists under deliberate omissions.
 */
export const STUDIO_HANDOFF_FLOW_DEFINITION = {
  description: 'Demo scaffold: answer a call handed off by the AI agent by dialling the browser softphone.',
  states: [
    {
      name: 'Trigger',
      type: 'trigger',
      properties: { offset: { x: 0, y: 0 } },
      transitions: [
        // Only the voice trigger is wired. The other two are declared with no `next` because the schema
        // expects the trigger's transition list, and leaving them unrouted is how "this flow is
        // voice-only" is expressed in data.
        { event: 'incomingCall', next: 'connect_to_softphone' },
        { event: 'incomingMessage' },
        { event: 'incomingRequest' },
        { event: 'incomingParent' },
      ],
    },
    {
      name: 'connect_to_softphone',
      type: 'connect-call-to',
      properties: {
        noun: 'client',
        to: CLIENT_IDENTITY,
        caller_id: '{{contact.channel.address}}',
        timeout: 30,
        offset: { x: 200, y: 240 },
      },
      transitions: [{ event: 'callCompleted' }, { event: 'hangup' }],
    },
  ],
  initial_state: 'Trigger',
  flags: { allow_concurrent_calls: true },
} as const;
