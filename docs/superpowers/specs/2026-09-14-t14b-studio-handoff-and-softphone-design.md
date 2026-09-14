# T14b — Studio handoff + browser softphone (design)

Written 2026-09-14, against `twilio-agent-connect@2.2.0` and the live demo account. Supersedes the
T14b section of `docs/HANDOFF.md` **where the two disagree** — six of that section's claims were
refuted or materially narrowed by executing them, and they are listed in §2 rather than quietly
fixed.

**No account-specific values appear in this file, by the same rule as `docs/HANDOFF.md`.** SIDs, the
phone number, the Conversation Orchestrator id, the memory-store id and the Studio flow SID live in
`.env` (gitignored) and in this project's session memory. This repo is *cloned* per demo; a committed
doc carrying one account's ids hands every future clone stale values that look authoritative. What is
here is the **method** and the **shapes**.

## 1. Goal

A caller talking to the voice agent asks for a human. The agent says one short line, the
ConversationRelay session ends, the call is routed to a **browser softphone** that a person actually
answers, and that person sees **why** the caller was transferred and **what was already said** before
they say hello.

Scope was set by three decisions taken before writing this:

1. **Both routing paths.** Our own route decides: redirect to Studio when a flow SID is configured,
   otherwise dial the browser client directly. Studio is a demo asset ("ops-editable routing"), not a
   hard dependency — a clone works with zero Studio setup.
2. **Screen pop.** The softphone shows the handoff reason and a transcript snapshot. Not a live
   memory/profile lookup: extraction is post-conversation only, so for a first-time caller that panel
   would be empty at exactly the moment it is being demoed.
3. **TAC-backed tool.** We use `createStudioHandoffTool` and supply the one thing it is missing on a
   streaming channel, rather than hand-building the frame.

## 2. Six corrections to `docs/HANDOFF.md` §T14b

Each found by executing something — a source read, a runtime probe, or a read-only account query.

### 2.1 ⚠ "Pin `actionUrl` … so the two can coexist" is WRONG as written

HANDOFF:206 says pinning `actionUrl` in `VOICE_TWIML_OPTIONS` lets `/conversation-relay-callback`
and Studio coexist. The precedence claim is true; the conclusion is not.

`/conversation-relay-callback` is **TAC's own route**, registered unconditionally
(`dist/index.js:6770-6791`). Its handler `handleConversationRelayCallback`
(`dist/index.js:5599-5619`) returns `{status: 200, content: "OK", contentType: "text/plain"}` —
**never TwiML**. And `ConversationRelayCallbackPayloadSchema` (`dist/index.js:1020-1051`) has **no
`HandoffData` field**; being a plain non-strict `z.object` it **strips it**.

So pinning `actionUrl` at TAC's path keeps the POST arriving and **silently discards the handoff**,
then ends the call. Coexistence requires pinning a **new path this repo owns** and returning routing
TwiML there. That is why `POST /voice/relay-action` exists in §4 and is not optional.

### 2.2 The precedence itself IS five layers, and is runtime-proven

`resolveActionUrl` (`packages/core/src/channels/voice.ts:1067-1087`; bundle `5447-5460`), in order:
`onInboundCallTwiml` → **`defaultTwimlOptions`** → host per-call → **Studio** → derived default.

There is **no ordering hazard**: `actionUrl` is resolved once up front (`voice.ts:1007-1009`) *before*
the three `overlayFields` calls, and `overlayFields` explicitly skips it (`voice.ts:1041-1043`).
Layers 1 and 3 are unreachable here — `onInboundCallTwiml` is never registered, and `TACServer` calls
`handleIncomingCall(twimlRequest)` with no options (`dist:6757`), so `host` is always `undefined`
inbound. **Nothing sits between `defaultTwimlOptions` and Studio.**

Proven by probe against this repo's own installed dist, not inferred:

| Probe | `defaultTwimlOptions` | Resulting `action` |
|---|---|---|
| A | repo as-is (`reportInputDuringAgentSpeech` only) | Studio's `webhooks.twilio.com/…/Flows/FW…?Trigger=incomingCall` |
| B | **+ `actionUrl: 'https://host/…'`** | our URL; no `webhooks.twilio.com` anywhere |
| D | `actionUrl: undefined` | **no `action` attribute at all** |
| E | `actionUrl: ''` | **no `action` attribute, and it did NOT throw** |

Probe E is a footgun: `TwiMLOptionsSchema` does declare `actionUrl: z.string().min(1)`, but
`VoiceChannelConfig` is a plain interface, so that validation never runs for `defaultTwimlOptions`. An
empty string silently removes end-of-call routing with no error. `as const` is not a barrier either —
the readonly literal typechecks against the constructor parameter.

### 2.3 ONE handoff tool, not two — and the split is voice-vs-everything

TAC's tool already branches internally: `if (session.channel === 'voice')`
(`packages/tools/src/built-in/handoff.ts:201`). `sms`, `chat`, `rcs` and `whatsapp` all take the
`else`. So the recorded "two tools, because SMS completes synchronously and voice must park" decision
describes TAC's *existing* behaviour rather than work to do.

- **Voice branch** does one thing and **cannot fail**: builds the frame, assigns it to the session,
  returns `handoff_initiated`. It never touches the WebSocket.
- **Digital branch** POSTs to the Studio Executions URL (10 s timeout, API key/secret basic auth) and
  **can** return `handoff_failed`.

The two wire shapes are **not interchangeable**: voice uses lowercase `handoffData` as a JSON
*string*; digital uses capital-H `HandoffData` as a nested *object* inside `Parameters`
(`handoff.ts:63-66`). A Studio flow reading `flow.data.HandoffData.conversationId` works on digital
and needs a parse step on voice.

### 2.4 The frame is ready-made, so "write it ourselves" is the wrong instinct

`session.pendingHandoffData` is a **complete frame**, not raw data:
`{type: 'end', handoffData: JSON.stringify(payload)}` (`handoff.ts:207-210`). TAC's own drain is five
lines (`packages/core/src/channels/voice.ts:834-843`; bundle `5246-5249`) and it sits inside
`sendResponse`. `grep pendingHandoffData` over `packages/` returns exactly four sites: the schema
field, the park, and the two drain lines. `sendStreamingResponse` (`voice.ts:869-932`) has **zero**
references.

Two further ways the frame gets stranded, both verified: TAC's own streaming example never drains it,
and TAC's only internal `sendResponse` caller fires only when `onMessageReady` returns a **non-empty
string** — so a streaming app and an empty-string return both leave it parked forever.

The double encoding is **required, not a defect**. Twilio documents the end message as
`{"type":"end","handoffData":"{\"reasonCode\":…}"}` and says to use a JSON-encoded string for
structured data, parsed in the action handler.

### 2.5 Landmine 3 is narrower than recorded — and we are fixing the path where it bites

`updateConversation(…, 'INACTIVE')` and `clearStatusCallbacks(…)` do run **before** delivery
(`handoff.ts:180-187`, `191-198`, then `200+`), both are warn-only, and TAC contains **no**
`'ACTIVE'` write and no inverse for `clearStatusCallbacks`.

But `handoff.ts:177-179` says: *"Downstream (Studio/Flex) flips it back to ACTIVE on pickup and
CLOSED on hangup — we don't close it ourselves."* So on the **success** path the status is reverted,
just not by TAC. The unreverted-broken-conversation outcome is specific to the **failure** path —
which is exactly the silently-unsent-frame case this task eliminates. Sending the frame is therefore
not merely the feature; it is the mitigation.

The `statusCallbacks` half has no downstream repair. A handed-off conversation stops calling
`/webhook` permanently, which is correct for a transferred call and worth stating out loud.

### 2.6 No TwiML Application is required, and `twilio` is not installed

- **Three** TwiML Applications exist on the account. None belongs to this scaffold (all point at
  other demos' hosts). More usefully: **a TwiML App is required only for OUTGOING.** Inbound to a
  browser client does not need one — `outgoingApplicationSid` is optional in `VoiceGrantOptions`, and
  `incomingAllow: true` is what permits receiving. **The softphone needs zero account mutations.**
- **`twilio` is not a declared dependency.** It exists only as TAC's unhoisted transitive dep in the
  pnpm store, so `AccessToken`/`VoiceGrant` are unimportable today. TAC's dist contains **zero**
  `AccessToken` references, so TAC will not mint the token for us.
- The exported API key is **not** policy-restricted (all keys `policy: null`); its flags are
  `["rest_api", "signing"]`. The long-standing 70004 on `accounts list` is the absence of
  `manage_keys`/`manage_accounts`, **not** a general permission shortfall — a non-mutating probe
  (POST to an impossible Application SID → 404; identical POST to an impossible Key SID → 401/70004)
  shows the Applications family is writable by this key. Token minting needs no API permission at all:
  it is a locally signed JWT, and the key carries `signing`.

## 3. Two hazards designed around rather than gambled on

### 3.1 The client identity must not contain a hyphen

The published flow dials `client:browser-agent`. The Voice JS SDK documents the token identity as
*"may only contain alpha-numeric and underscore characters"* — a hyphen is not in that set. Whether
it works in practice is undocumented and untested.

**Decision: the identity is `browser_agent`**, exported once from `shared/handoff.ts` and used by the
token route, the flow definition and the page. The flow is an **orphan** — no phone number references
it — so changing it costs nothing. This removes an undocumented dependency for free.

### 3.2 The softphone cannot correlate on CallSid

Studio's `connect-call-to` widget exposes only `caller_id`, `noun`, `timeout`, `to` — **it cannot
pass parameters to a client** — and dialling the client creates a **new call leg with a new CallSid**.
So `call.parameters.CallSid` in the browser is the child leg's SID and will never match the inbound
call.

**Decision:** correlate on the **caller's number** (`From`, which Studio preserves via
`caller_id: {{contact.channel.address}}`), with a **most-recent-snapshot fallback**, and have the
response state which match it was. On the direct-`<Dial>` path we additionally emit
`<Parameter name="conversationId">`, which the SDK surfaces as `call.customParameters` — that path
gets exact correlation because it can.

## 4. Architecture

```
model calls handoff(reason)
  └─ server/twilio/handoff.ts  (our ToolDef)
       1. snapshot history.read(conversationId) + reason   ← BEFORE the socket closes
       2. delegate to TAC's createStudioHandoffTool(tac, session)
            INACTIVE → clearStatusCallbacks → park {type:'end', handoffData:"<json>"}

server/twilio/voice.ts, after sendStreamingResponse RESOLVES (farewell already spoken)
  └─ drain session.pendingHandoffData → ws.send(...)       ← the 5 lines TAC omits here
     publish obs `handoff`

ConversationRelay ends the session; Twilio POSTs the <Connect action> URL
  └─ POST /voice/relay-action        (OURS — see §2.1)
       HandoffData present?
         ├─ flow SID configured → <Redirect> Studio's webhook
         └─ otherwise           → <Dial><Client>browser_agent</Client></Dial> + <Parameter>
       absent (the end_call path) → <Hangup/>

softphone, on `incoming` → GET /api/handoff/context?from=… → screen pop → answer
```

### Why the drain goes after `sendStreamingResponse` resolves

Identical reasoning to `end_call`, and the same position in the handler. A tool runs inside the model
loop, before the turn's text exists; ending the session there cuts the caller off mid-sentence. By the
time the send resolves, the farewell has streamed and its `last: true` marker has gone out. This also
preserves the measured property that ConversationRelay drains queued audio before closing (1.75 s gap
observed on the `end_call` call).

## 5. Components

| File | Change | Notes |
|---|---|---|
| `server/twilio/handoff.ts` | **new** | ToolDef wrapping TAC's tool. Resolves `ConversationSession` from the **channel** — `getConversationSession` is public on `BaseChannel`, **not** on `TAC`. Bounded snapshot store, same shape as `end-call.ts`'s |
| `server/twilio/voice.ts` | edit | `VOICE_TWIML_OPTIONS.actionUrl`; drain after streaming; handoff-beats-`end_call` |
| `server/http/routes-voice-action.ts` | **new** | The action route. Parses the double-encoded `HandoffData`; returns TwiML on every path |
| `server/http/routes-handoff.ts` | **new** | `GET /api/handoff/context`; `POST /api/voice/token` (AccessToken + VoiceGrant, `incomingAllow: true`) |
| `shared/handoff.ts` | **new** | `CLIENT_IDENTITY = 'browser_agent'`, route paths, the context type shared with `web/` |
| `shared/tac-tool-names.ts` | edit | Add `handoff` |
| `server/twilio/tac.ts` | edit | Register the tool in the augmented catalog built inside `bootTac` |
| `server/agent/prompt/defaults.ts` | edit | Name `handoff` in both prompts' `config.tools`, plus when-to-transfer guidance |
| `web/src/app/softphone/page.tsx` | **new** | Client island; `@twilio/voice-sdk` **dynamically** imported |
| `scripts/seed-studio-flow.ts` + committed definition | **new** | Mirrors `seed-prompts`/`seed-knowledge` |
| `docs/HANDOFF.md` | edit | Fold in §2 and §3 |

### Five wiring constraints that are easy to miss

1. **`handoff` MUST be added to `shared/tac-tool-names.ts`**, or `resolve()` classifies it `unknown`
   rather than `unavailable` and warns once per bench turn. ⚠ `builtin-tools.ts` indexes that module
   **positionally** — adding an entry requires checking those index sites.
2. **A live test asserts `handoff` is absent from the adapters.** Adding a real one flips it
   deliberately; update the assertion rather than working around it.
3. **`run-turn.ts`'s `instrument()` rebuilds a `ToolDef` field by field**, copying only
   `name`/`description`/`input`/`requires`. Any *new* `ToolDef` field is silently dropped — so the
   design adds none.
4. **The obs vocabulary already has a `handoff` event kind** with an assigned tone; no
   `shared/events.ts` change. Note `handoff` is currently a **fixture string** in the dev-emit
   endpoint's `unavailable` bucket, so that fixture's meaning changes.
5. **`@twilio/voice-sdk` emits a `console.warn` at module load** in a non-browser context, which
   would hit every SSR pass. Import it dynamically, client-side only.

### Tool description is load-bearing

The same argument as `search_knowledge`. TAC's factory takes `name` and `description` as overridable
options, and the default (*"Use this when the customer requests a human, or when you cannot adequately
handle the request"*) invites transfers whenever the model feels stuck — which on a demo means
transferring instead of using `search_knowledge`. We supply our own, and the *when* lives in the
Langfuse-versioned prompt so it is tunable without a redeploy.

Note also that `attributes = {...staticAttributes, reason: params.reason}` — the model's `reason`
always overwrites a static one, and `attributes` is the **only** extension point, since the payload's
four keys are fixed. `reasonCode` (Twilio's convention) therefore rides inside `attributes`.

## 6. `end_call` versus handoff

Both terminate in `{"type":"end"}` on one socket; two frames is undefined behaviour. The policy lives
in `voice.ts`, the one place both are visible:

> **Check the parked handoff frame first. If one exists, `forgetEndCallRequest()` and send only the
> handoff frame.**

Transfer wins unconditionally — hanging up on someone who has just asked for a human is the worst
available outcome. `handleVoiceDisconnect` must clear the handoff snapshot too, for the same reason it
already clears the `end_call` intent: Orchestrator reuses a conversation id per profile, so a leaked
intent acts on a later call.

## 7. Error handling

- **The action route returns valid TwiML on every path**, including unparseable `HandoffData`. A throw
  there is a dropped call. Unparseable → `<Hangup/>` plus a loud log, never a 500.
- **`actionUrl` is asserted non-empty at boot**, because probe E shows an empty string silently
  deletes the attribute without throwing.
- **A snapshot failure must not block the transfer.** The screen pop degrades to reason-only.
- **`<Hangup/>` on the no-handoff path changes today's behaviour.** Today TAC answers with
  `text/plain "OK"` and Twilio drops the call; HANDOFF records that no alert is raised and says not to
  "fix" it. Owning the route makes returning TwiML unavoidable, and `<Hangup/>` is a cleaner
  disposition — but it is a **behaviour change on a working path** and needs live re-verification, not
  assumption.
- **The token route never returns a token on a misconfigured process** — it 503s naming the missing
  variable, consistent with the house rule.

## 8. Account changes

| Change | Reversible? | Backup |
|---|---|---|
| Update the Studio flow: add `set-variables` for `{{trigger.call.HandoffData}}` typed `json_object`; change `to` → `browser_agent` | Yes | Twilio retains the prior **revision**; the seed script fetches and writes it to disk before publishing, per `repoint-public-host.ts`'s pattern |
| `TWILIO_STUDIO_HANDOFF_FLOW_SID` in `.env` | Yes | n/a — this is what flips `capabilities().handoff` and what makes §2.2 matter |

No TwiML Application. No CO configuration change — voice `captureRules` **stay empty** (re-adding
them double-bills STT under ConversationRelay).

`json_object` is the load-bearing detail: that widget type is what un-double-encodes the value, after
which `flow.variables.handoffData.*` resolves.

## 9. Verification ladder — free before billed

Integration over unit, per house convention, and every rung below costs nothing:

1. `pnpm typecheck && pnpm test`.
2. **Signed `POST /twiml`** → assert `action` now points at `/voice/relay-action` and that
   `conversationConfiguration` and `reportInputDuringAgentSpeech` are still on the wire. This is the
   single highest-value check: it proves §2.2 on the real process.
3. **Signed POSTs of a synthetic `HandoffData`** to `/voice/relay-action` → prove both TwiML branches
   (flow SID set vs unset) and the unparseable path.
4. **Softphone registers** as `browser_agent` with no call placed — proves the token route, the grant
   and the identity charset question in §3.1.
5. **`GET /api/handoff/context`** against a synthetic snapshot → proves the screen pop renders.
6. **Then one real call**: ask for a human, confirm the farewell is heard, the softphone rings, the
   pop shows reason + transcript, and one `conversation.voice` trace holds every turn plus a `handoff`
   event.

Rung 4 is what the schedule risk in the briefing was about: the transfer cannot be demonstrated at all
until a client is registered, so the softphone is built **before** the frame work is verified
end-to-end.

## 10. Honest limits

- **Screen-pop correlation is caller-number + most-recent.** Two simultaneous calls from the same
  number would cross. Acceptable for a demo; stated rather than hidden.
- **The transcript is a new PII surface.** `obs/pii.ts` scrubs log lines and obs payloads; it does not
  scrub this route's body, and it must not — the human agent needs the real words. The caller's number
  is masked in the UI; the transcript is verbatim by necessity.
- **One identity allows 10 concurrent registrations**; the 11th evicts the oldest. Two demo tabs are
  fine, eleven are not.
- **A handed-off conversation stops calling `/webhook` permanently** (§2.5), so it will not produce a
  `CONVERSATION_UPDATED`/CLOSED event, and Conversation Memory extraction for it may therefore never
  fire. Worth measuring — it is the one place this feature could quietly cost T14's memory story.
- **The repo's 7-day supply-chain guard is not enforced.** pnpm 11.8 does not read
  `minimum-release-age` from `.npmrc`, and `pnpm-workspace.yaml` has no `minimumReleaseAge`. Reported,
  not policed: `@twilio/voice-sdk` is pinned to a version older than 7 days by hand, and `twilio` is
  pinned to **5.13.1** to dedupe with TAC's copy rather than pull the 6.x line as a second install.
- **`twil docs` has an empty knowledge base on this machine** (`twil import` would populate it). The
  Twilio documentation cited here came from the docs MCP tool, not `twil`.
- **Twilio ships no blessed template for this.** Its own handoff Studio template routes to Flex, not
  to a browser client.

## 11. Deliberately omitted

No live memory/profile panel in the softphone (§1). No outbound calling from the browser — that is
what would require a TwiML App. No Flex. No no-answer branch beyond what the flow's 30 s timeout
gives, and no voicemail fallback. No second Studio flow.
