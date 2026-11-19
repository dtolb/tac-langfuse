# ConversationRelay tuning — design (DRAFT)

Change ConversationRelay STT, TTS and turn-taking settings from `/tuning`, apply the dynamic ones to every live call on the next turn and the rest to the next call, and follow each change on a per-call timeline and in Langfuse. Mockup: `web/src/app/tuning/` (static data, run `pnpm dev:all` and open `/tuning`).

## Decisions so far

- Apply reaches **all live calls**; the full profile also becomes the next call's TwiML.
- Timeline is **merged**: live lanes from this agent, Voice Insights Events backfilling caller/STT/TTS/audio (~90 s lag). Advanced Features is on for the account (`GET insights.twilio.com/v1/Voice/Settings` → `advanced_features: true`).
- In scope beyond the controls: **presets and compare**. Out of scope: language switching, `applicationReconnect`, CI operators.
- **Upgrade `twilio-agent-connect` 2.2.0 → 2.5.0.**
- New source files carry TSDoc only.

## Sources

- Dynamic config: https://www.twilio.com/docs/voice/conversationrelay/dynamic-configuration
- Noun attributes: https://www.twilio.com/docs/voice/conversationrelay/conversationrelay-noun
- WebSocket messages: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- Timeline method: https://pages-4296.twil.io/conversation-relay-insights
- Changelog 2026-10-28 and blog 2026-11-17 (linked from the request).

## Parameter catalog

One catalog in `shared/cr-params.ts` (pure data, both tsconfigs compile it), consumed by the page, the frame builder and the TwiML builder. The mockup's `PARAMS` is the draft.

| Timing | Parameters | Frame slot |
|---|---|---|
| now | `reportInputDuringAgentSpeech`, `partialPrompts`, `interruptible`, `preemptible` (last two from the next reply) | session |
| end of caller's turn | `transcriptionProvider`, `speechModel`, `hints` | language |
| end of caller's turn | `speechTimeout`, `eotThreshold`, `interruptSensitivity`, `ignoreBackchannel`, `echoPromptFiltering`, `dtmfDetection`, `profanityFilter` | session |
| end of caller's turn (not in the dynamic-config reference; confirm on first call) | `turnDetection`, `deepgramSmartFormat` | session |
| next reply | `ttsProvider`, `voice` (incl. ElevenLabs model suffix), `elevenlabsTextNormalization` | language |
| next call (rejected in `config`) | `welcomeGreeting`, `welcomeGreetingInterruptible`, `events`, `partialPromptOnHangup` | TwiML |
| next call (not listed either way) | `includeInPrompt` | TwiML |

Pairing: `ttsProvider` always travels with `voice`, `transcriptionProvider` with `speechModel`. Values are strings in the profile (the `configUpdated` encoding) and typed on the wire.

`events="config-updated"` is always emitted — it cannot be added mid-call and `configUpdated` is the only confirmation.

## Backend

1. **TAC 2.5.0.** Bump, run the suite, and re-drive the `actionUrl` precedence check that `buildVoiceTwimlOptions` documents against 2.2.0. 2.5.0 has no `config`/`hints`/`language` sender, drops inbound `info` and `error` at debug, and strips `setup.connectionType`.
2. **Profile store** — `data/cr-profile.json` (current profile + revision number) and `data/cr-presets.json`. Read on boot, written on Apply / preset save.
3. **Next call** — register `voiceChannel.onInboundCallTwiml`, mapping the profile onto `TwiMLOptions` (typed fields, `extra` for attributes 2.5.0 does not type), layered over `defaultTwimlOptions` so `actionUrl` and `reportInputDuringAgentSpeech` survive.
4. **Live registry** (`server/twilio/`) — per conversation: callSid, socket from `voiceChannel.getWebsocket()`, profile revision at start, effective config. A second `message` listener on that socket reads `info`/`configUpdated` and `error`, which TAC does not surface.
5. **Apply** — `POST /api/tuning/apply { profile }`: diff against the saved profile, save it, build one `config` frame from the live-applicable keys, send it to every live socket, return per-call results. Also `GET /api/tuning` (profile, presets, live calls with effective config) and `PUT /api/tuning/presets/:name`.
6. **configUpdated** — values arrive as strings and describe current state, not a receipt. Match delta keys to the call's pending apply to compute time-to-effect. The three session-start events become the call's recorded starting config.
7. **OTel** — under the call's root span:
   - `cr.config.apply` (zero-duration): `cr.config.apply_id`, `cr.config.revision`, `cr.config.changes` (JSON `[{key, from, to, timing}]`), `cr.config.frame` (JSON).
   - `cr.config.updated` (zero-duration): `cr.config.delta` (JSON), `cr.config.apply_id`, `cr.config.since_apply_ms`, `cr.config.initial` for session-start events.
   - `cr.config.error`: Twilio's `description`.
   - Every `turn.voice` span gets `cr.config.revision`, so Langfuse can filter turns by profile.
   - The same three go on the bus as new `ObsEventKind`s so `/events/stream` shows them live.
8. **Timeline** — `GET /api/calls/:callSid/timeline` merges this agent's turn records (prompt receipt, first token, last token, interrupts, config events) with Voice Insights `GET /v1/Voice/{CallSid}/Events?Edge=carrier_edge&PageSize=1000` (rows where `group == "conversation_relay"`, sorted by `(session_id, sequence_number)`, paged via `meta.next_page_url`) and `/Summary` for a cross-check. Derivations follow the insights page: `utterance_end = t(end_of_customer_speech) − stt_latency.latency_ms`; wait = STT + app + TTS. Cached in memory per call.

## Web

`/tuning` as the mockup, laid out from the UX review:

- **Sticky Apply bar** at the top: staged changes on one line (with the preset that staged them), "Apply → N live calls + next call", Discard. After an Apply and until the next edit it shows a receipt: each live call's took-effect time and "saved for next call". "Show wire" opens the exact `config` frame and next-call TwiML below the bar, not inside it, so it scrolls away.
- **Header**: the live profile as `rev N` plus where it came from (preset and edit count), and "Stage a preset…". A preset is a partial overlay — it stages only the keys it defines.
- **Settings rail** (left): Turn-taking, Speech-to-text, Text-to-speech, each with rows under one timing subhead per class, the subhead printing what that timing means; about 12 common settings shown, the rest behind "More (n)"; "Next call only" folded with a changed count. Each row shows its label, attribute name (mono) and, when changed, "was X". Dependencies disable the control and say why (smart turn detection under flux, end-of-turn threshold without flux or turn detection, ElevenLabs-only fields). Help follows one rule — nothing needed before acting, and no link, is hover-only: an ⓘ tooltip (hover and focus, plain text) says what the setting does; a visible ↗ beside it opens the docs page; one link at the top of the rail goes to the dynamic-configuration reference.
- **Call workspace** (right, sticky): one tab per call — live calls first with a timer and an "applying" marker, ended calls after — defaulting to the live call that last received an Apply. Per-turn wait is the default view, each row printing `STT · App · TTS = wait`; each Apply is a divider row before the turn it was sent during, showing each key's change, its took-effect time and first turn from `configUpdated`, and the median wait/STT/app/TTS change against the previous revision. Whole call and Table views follow. Compare picks two call-and-revision segments, defaulting to this call's previous vs latest revision and resetting when a revision gains turns; turns split across revisions are left out and counted.
- Live state over the existing `/events/stream`.

## To measure on the first real call

- That `turnDetection` and `deepgramSmartFormat` are accepted in a `config` frame and land at end of turn (send one, read `configUpdated` or the `error`); same check for `includeInPrompt`.
- How `configUpdated` reports an ElevenLabs model suffix; the v3 suffix.
- The Google `speechModel` values ConversationRelay accepts.
- Clock alignment between Voice Insights events and this agent (anchor: `prompt` receipt ↔ `prompt_sent`).
- That Langfuse renders the zero-duration spans on the timeline.
