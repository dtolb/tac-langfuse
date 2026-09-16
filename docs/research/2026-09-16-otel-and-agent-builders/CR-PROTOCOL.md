# ConversationRelay WebSocket protocol

## Bottom line

ConversationRelay always requires an application **WebSocket** server — the `url` attribute is documented as "The URL of your WebSocket server. The URL must begin with `wss://`." There is no native HTTP or SSE ingress. An external agent runtime can sit behind it, but something must terminate a `wss://` socket and speak the JSON protocol below. Twilio publishes **no** WebSocket idle timeout, no maximum app response time, and no time-to-first-token target — only a qualitative "stream tokens as soon as they are available."

## 1. Twilio → app messages (complete documented set)

From [Getting and sending WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages). Five types are documented; `debug`/`events` unlock more (see §7).

`setup` — sent immediately after the socket is established:
```json
{"type":"setup","sessionId":"VX…","accountSid":"AC…","parentCallSid":"","callSid":"CA…","from":"+18005550100","to":"+18005550101","forwardedFrom":"+18005550102","callType":"PSTN","callerName":"","direction":"inbound","callStatus":"RINGING","customParameters":{"callReference":"bar"}}
```
`customParameters` carries `<Parameter name value>` children.

`prompt` — `{"type":"prompt","voicePrompt":"…","lang":"en-US","last":true}`. `last` "indicates whether the caller speech has completed based on the report from the speech-to-text provider and the configuration of this ConversationRelay session. For example, when `speechTimeout` is enabled, `last` will be sent after the specified `speechTimeout` is reached." With `partialPrompts="true"` (Deepgram `flux` only) you also get unfinalized prompts with `last=false`.

`dtmf` — `{"type":"dtmf","digit":"1"}` (requires `dtmfDetection="true"`).

`interrupt` — `{"type":"interrupt","utteranceUntilInterrupt":"Life is a complex set of","durationUntilInterruptMs":460}`.

`error` — `{"type":"error","description":"Invalid message received: …"}`.

Handshake carries an `X-Twilio-Signature` header, validated the same way as an HTTP webhook; the docs say your server "must validate" it.

## 2. App → Twilio messages

`text` (TTS tokens):
```json
{"type":"text","token":"Hello world!","last":false,"interruptible":false,"preemptible":false}
```
- `type` required, `token` required and cannot be `null` — "Don't trim LLM tokens; the tokens should have appropriate spaces between them."
- `last` optional, default `false` — "the final token in the current message"/talk cycle.
- `lang` optional, overrides session TTS language for that token.
- `interruptible` optional boolean, overrides the TwiML attribute per-message.
- `preemptible` optional boolean — "Whether subsequent `text` or `play` messages from your application will stop this media playback. When set to `true`, sending a new message replaces the current one."
- SSML passthrough inside `token`; with ElevenLabs only `<phoneme>` and only `en-US`.

`play` — `{"type":"play","source":"https://…mp3","loop":1,"preemptible":false,"interruptible":true}`. `loop:0` plays 1,000 times (max), default `1`.

`sendDigits` — `{"type":"sendDigits","digits":"9www4085551212"}`; only `0-9`, `w`, `#`, `*`.

`language` — `{"type":"language","ttsLanguage":"sv-SE","transcriptionLanguage":"en-US"}`; at least one of the two required.

`end` — `{"type":"end","handoffData":"{\"reasonCode\":\"live-agent-handoff\",…}"}`; the string is delivered to the `<Connect action>` callback. Docs warn it is not treated as PCI data.

## 3. Incrementality, chunking, buffering

- No minimum chunk size, no maximum send rate, and no documented buffer depth. The only guidance is [best practices](https://www.twilio.com/docs/voice/conversationrelay/best-practices): stream tokens "as soon they become available instead of waiting for the LLM to generate a complete response. This will allow Conversation Relay to begin speaking the response to your caller sooner." Batching the whole response "can introduce significant latency but it might offer a smoother and more consistent pace of speaking."
- Per-token granularity is explicitly sanctioned — the doc's own example is three frames: `"Hello"` / `" world"` / `"!"` with `last:true` on the third. Pattern: set `last:true` when the LLM's `finish_reason == "stop"`. "For messages with complex punctuation, consider breaking the response into smaller chunks."
- **Indirect evidence that Twilio buffers to sentence boundaries before synthesis:** the Voice Insights event `tts_latency` is defined as "Time from receiving a text **sentence** to start of audio synthesis" ([Conversation Relay Insights Events](https://www.twilio.com/docs/voice/voice-insights/api/call/details-conversation-relay-events)). The docs never state the aggregation rule outright, so treat sentence-level chunking as inference, not a documented contract.
- Message validation failures return error `64107` and do **not** end the session, but the message is dropped. Ten consecutive unidentified messages closes the socket with WebSocket status `1007` "Too many consecutive malformed messages" and reports error `64105`.

## 4. Interrupt / barge-in

- Twilio detects the barge-in and stops TTS playback itself (subject to `interruptible` / `interruptSensitivity` / `ignoreBackchannel`), then sends the `interrupt` message with `utteranceUntilInterrupt` — the text the caller actually heard — and `durationUntilInterruptMs`.
- **What happens to text already sent but not spoken: the docs do not say.** Nothing on the WebSocket-messages or TwiML page states whether queued-but-unspoken tokens are discarded. The observable contract is only `utteranceUntilInterrupt`, from which you infer the truncation point.
- The app's expected job is not spelled out in the reference either; Twilio's tutorials (blog, not docs) show cancelling the in-flight LLM generation and truncating the assistant turn in local history at `utteranceUntilInterrupt`.
- `reportInputDuringAgentSpeech` (default `none` since May 2025) is orthogonal: it controls whether you *receive* `prompt`/`dtmf` while the agent speaks, "regardless of whether playback is interrupted." `interruptible="none"` + `reportInputDuringAgentSpeech="speech"` observes barge-in without cutting TTS.
- `preemptible` is the other direction: a new `text`/`play` from your app interrupts current playback. Insights logs this as a distinct `preempted` event, separate from `interrupt` (whose `type` is `DTMF` or `SPEECH`).

## 5. Latency guidance and limits — mostly absent

Documented:
- `speechTimeout`: 600–5000 ms integer, default `auto` — "the amount of time … Conversation Relay waits after the end of speech before reporting the final prompt over the WebSocket." With Deepgram `flux` it is forwarded as a maximum silence duration instead.
- `eotThreshold` 0.5–0.9, default 0.8 (Deepgram `flux` only).
- Observability, not SLA: Insights events `first_token_received` ("Marks the end of application latency"), `final_token_received` (+`total_tokens`, `total_words`), `stt_latency` and `tts_latency` (both `latency_ms`), `start_/end_of_agent_speech`, `start_/end_of_customer_speech`. These are the only quantified latency surface Twilio exposes, and they are emitted at `carrier_edge` (pass `Edge=carrier_edge` or you get nothing).
- Error codes bounding the session: `64104` Max Call Duration Reached, `64108` RTP Timeout (no audio packets), `64109` Concurrency Limit Reached, `64102` unable to connect to the WebSocket URL, `64105` WebSocket Ended, `64111`/`64112` TTS provider/conversion errors (non-session-ending).

**Not documented anywhere I fetched:** WebSocket idle/ping timeout, a deadline for the app to send its first `text` after a `prompt`, any time-to-first-token target, the numeric max call duration, and the numeric concurrency limit. No estimate offered.

If the socket drops, "we don't reconnect, and the call disconnects with a `failed` status" — recovery means returning fresh `<Connect><ConversationRelay>` TwiML from the `action` callback and checking `callSid` continuity.

## 6. `<ConversationRelay>` attributes (from the [TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay))

Latency/turn-taking: `speechTimeout` (600–5000, default `auto`), `eotThreshold` (0.8), `partialPrompts` (false), `interruptSensitivity` (`high`|`medium`|`low`, default `high`), `ignoreBackchannel` (false), `preemptible` (false), `elevenlabsTextNormalization` (`on`|`auto`|`off`, default `off` — "Set the attribute to `off` for more control over the text normalization process and lower latency").

TTS: `ttsProvider` (`Google`|`Amazon`|`ElevenLabs`, default **ElevenLabs**), `voice` (defaults `UgBBYS2sOqTuMpoF3BR0` ElevenLabs, `en-US-Journey-O` Google, `Joanna-Neural` Amazon), `ttsLanguage`, `language` (default `en-US`, sets both directions).

STT: `transcriptionProvider` (`Google`|`Deepgram`, default **Deepgram**, or `Google` for accounts using CR before 2025-09-12), `speechModel` (defaults `telephony` for Google; `nova-3-general` where supported else `nova-2-general` for Deepgram), `transcriptionLanguage`, `hints`, `deepgramSmartFormat` (true).

Interruption/greeting: `welcomeGreeting`, `welcomeGreetingInterruptible` (`none`|`dtmf`|`speech`|`any`, default `any`), `interruptible` (same enum, default `any`; booleans accepted, `true`=`any`, `false`=`none`), `reportInputDuringAgentSpeech` (default `none`), `dtmfDetection`.

Other: `events` (space-separated `speaker-events`, `tokens-played`), `debug` (`debugging`; the other two moved to `events` but still accepted), `intelligenceService`, `conversationConfiguration`, `conversationId`.

Nested: `<Language code|multi ttsProvider voice transcriptionProvider speechModel>` — one per language, and adding it does **not** activate it; `<Parameter name value>` → `customParameters` in `setup`.

## 7. STT/ASR division of control

Twilio owns transcription end to end: provider, model, smart formatting, endpointing. The app influences it only through TwiML at call setup (`transcriptionProvider`, `speechModel`, `hints`, `deepgramSmartFormat`, `ignoreBackchannel`) plus endpointing knobs `speechTimeout` and, on Deepgram `flux`, `eotThreshold` and `partialPrompts`. VAD sensitivity as such is not exposed — the closest is `interruptSensitivity`, which gates barge-in "based on speech recognition confidence and input length," not raw audio energy. Mid-session, the only STT change available is the `language` message (`transcriptionLanguage`); best practices state "Once the session starts, you can't modify voice and language configurations set in TwiML through WebSocket messages." Raw audio never reaches the app — you get text only.

## 8. Implication for an external agent runtime

Viable, with one shim: your process must own a `wss://` listener that validates `X-Twilio-Signature` on the handshake, keeps a per-`callSid` session, and translates prompt→agent-turn and agent-tokens→`text` frames. An HTTP/SSE agent backend can sit behind that shim, but the shim is mandatory and it is the thing that must abort in-flight generation on `interrupt` — Twilio stops the audio but will not stop your model.

## Citations

- https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
- https://www.twilio.com/docs/voice/conversationrelay/best-practices
- https://www.twilio.com/docs/voice/conversationrelay/onboarding
- https://www.twilio.com/docs/voice/conversationrelay
- https://www.twilio.com/docs/voice/voice-insights/api/call/details-conversation-relay-events
- https://www.twilio.com/en-us/blog/anthropic-conversationrelay-token-streaming-interruptions-javascript
- https://www.twilio.com/en-us/changelog/conversationrelay-is-now-available-in-ga

## Unverified

- Exact JSON shape of the debug-gated messages: `speaker-events` (`agentSpeaking`/`clientSpeaking`) and `tokens-played`. The TwiML page documents the `events`/`debug` attributes and names the events, but no page I fetched shows their payload field names. The websocket-messages page does not list them at all.
- Whether Twilio discards queued-but-unspoken `text` tokens on `interrupt`, or resumes them. Not stated on any page fetched.
- Whether Twilio buffers tokens to sentence boundaries before starting TTS. Inferred only from the Insights definition of `tts_latency` ('time from receiving a text sentence to start of audio synthesis'); never stated as a protocol rule.
- Any WebSocket idle/ping timeout, or a deadline for the app to respond after a `prompt`. Absent from websocket-messages, best-practices, onboarding and the TwiML reference.
- Numeric values behind error 64104 (max call duration) and 64109 (concurrency limit). The error table names both without figures; no /docs/voice/conversationrelay/limits page exists (404).
- Any published time-to-first-token or end-to-end latency target/SLA.
- The interrupt-handling responsibilities of the app (cancel LLM generation, truncate history) come from Twilio blog tutorials, not the reference docs. I read them via search-result summaries rather than fetching the blog posts, so the code specifics are second-hand.
- Whether ConversationRelay has any non-WebSocket ingress in private beta or via Conversation Orchestrator. The public docs only ever show `url` requiring `wss://`; absence of documentation is not proof of absence.
