# 01 The injection surface and the span model

Agent Connect emits no telemetry of its own. Grepping the shipped 2.2.0 bundle for `opentelemetry`, `AsyncLocalStorage`, `trace.getTracer` and `traceparent` returns zero matches, and the upstream repository has never had an issue or pull request mentioning OpenTelemetry, tracing, spans, metrics or any tracing vendor. Total timing data the library hands you is three numbers, none of which it measured of itself: `durationUntilInterruptMs` parsed out of the ConversationRelay `interrupt` frame, a memory query time echoed from the platform in one debug log, and the call, machine-detection and recording durations that arrive as strings on webhook forms. Everything else you will trace, you will time yourself, from the outside.

This section is about where "outside" actually is. The rest of the page covers the code layers and the failure modes; the architecture and the turn walkthrough are already published at [/agent-scaffold-architecture](https://pages-4296.twil.io/agent-scaffold-architecture) and are not repeated here.

## The correction to make first

The obvious reading of the library is that `onMessageReady` is the response path, so a turn span should open when that callback fires and close when it returns. That reading is wrong for voice, and it is the single most expensive misconception to hold while designing spans.

`onMessageReady` returns `Promise<string | null | void>`. The dispatcher checks `typeof response === "string"` and, if so, calls `channel.sendResponse(...)`, which writes one frame carrying `last: true`. That is a non-streaming convenience. Return `null` or `void` and the library sends nothing at all. There is no token sink in the callback parameters and no writable to hand tokens to.

Streaming happens because `VoiceChannel.sendStreamingResponse(conversationId, stream, options?)` is a public method with the signature below, read from the shipped type declarations of `twilio-agent-connect@2.2.0`:

```ts
sendStreamingResponse(
  conversationId: ConversationId,
  stream: AsyncIterable<string>,
  options?: { signal?: AbortSignal },
): Promise<string>;
```

You supply the `AsyncIterable<string>`. Inside, the library iterates it and performs one synchronous `ws.send` per chunk, writes the `{ type: "text", token: "", last: true }` marker after the loop only if at least one token went out and the signal did not fire, and resolves with the accumulated text. The seam is not a callback you are handed; it is a method you call back into.

Three consequences for anyone instrumenting a turn. First, the turn boundary you want is the instant the `prompt` payload reaches your handler paired with the instant that `last: true` marker leaves the socket, and both of those instants are yours to stamp, because you own the first line of the handler and you own the iterable. Second, because the per-chunk send is synchronous inside the library's own `for await`, the moment your generator yields its first non-empty text delta is within microseconds of the moment the frame hits the socket, which is what makes a server-side first-audio proxy meaningful at all. Third, the streaming path is voice-only by construction. The messaging and chat path is `MessageReadyCallback`, whose parameters carry `memory: TACMemoryResponse | undefined` (not `userMemory`, which is the voice `prompt` payload's spelling) and whose `abortSignal` is optional, unlike the voice `prompt` payload where it is required. There is no streaming sink for SMS or chat, so a messaging turn span has exactly one interior timing you did not measure yourself, and token-level attributes on that channel are not available at any price.

## Every extension point 2.2.0 exposes

Signatures below are read from the shipped `twilio-agent-connect@2.2.0` type declarations and implementation bundle. `BaseChannel.on` is not an EventEmitter: it is a `switch` that assigns into one of a fixed set of single slots, its callback is typed `(...args: any[]) => void` so nothing about the payload is typechecked at your call site, and an unrecognised event string falls through with no default and is silently dropped. Registering a channel with the top-level object calls `on` for `error`, `messageReceived`, `prompt`, `interrupt` and `conversationEnded`, so those five slots are taken from you if you register, and taking them back after registering silently stops the top-level callbacks firing for that channel. The four slots the library never claims are `setup`, `conversationStarted`, `webSocketConnected` and `webSocketDisconnected`.

| Point | Exact signature or payload | Span or attribute it can produce | What it structurally cannot see |
|---|---|---|---|
| `voiceChannel.on('setup', cb)` | `{ callSid: string; from: string; to: string; customParameters: Record<string,unknown> \| undefined }` | Trace-level correlation keys, including a call identifier suitable for `gen_ai.conversation.id`; the earliest point at which a conversation root could be opened | Nothing about turns. It fires before any prompt, and it cannot tell you whether a conversation record exists yet |
| `voiceChannel.on('webSocketConnected', cb)` | `{ conversationId }`; fires from two distinct sites, direct connect and orchestrated adoption | The open boundary of a call-level span | Which of the two sites fired it, without inspecting state yourself |
| `voiceChannel.on('webSocketDisconnected', cb)` | `{ conversationId }` | The close boundary of a call-level span, and on the voice path this is the signal that actually arrives; in orchestrated operation a hangup fires no `conversationEnded` at all | Why the socket closed. Caller hangup, transport failure and shutdown are indistinguishable here |
| `voiceChannel.on('prompt', cb)` | `{ conversationId; transcript: string; abortSignal: AbortSignal; userMemory?: TACMemoryResponse; session?: ConversationSession }`, awaited by the library | Turn span start, a zero-duration transcript event, and the closing edge of a back-dated caller-side span | Speech-to-text arrival, WebSocket frame parse, stream-task setup, and the platform memory recall, all of which happen before your first line runs. Also `lang` and `agentSpeaking`, which the inbound schema parses and the handler then does not forward in 2.2.0 |
| `voiceChannel.sendStreamingResponse(id, stream, { signal })` | `(ConversationId, AsyncIterable<string>, options?: { signal?: AbortSignal }) => Promise<string>` | A bot-output span anchored at the first non-empty delta and closed at the end-of-turn marker, plus a server-side time-to-first-audio proxy | Text-to-speech synthesis and playback. ConversationRelay exposes neither over the socket, so the audible half of the turn is invisible from this process |
| `voiceChannel.on('interrupt', cb)` | `{ conversationId; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }`, not awaited, and with no `session` | A barge-in event and the correct turn boundary on an interrupted turn | Any ambient trace context. The library dispatches this from its own socket handler, so a span started here with no explicit parent becomes the root of a second trace |
| `tac.onMessageReady(cb)` | `(params: { conversationId; profileId; message; author; memory: TACMemoryResponse \| undefined; session; channel; abortSignal?: AbortSignal }) => Promise<string \| null \| void> \| string \| null \| void` | The entire messaging or chat turn span, opened on entry and closed when your promise settles | Any token-level timing. There is no streaming sink on this path, so first-token latency on SMS and chat is not measurable |
| `messagingChannel.on('messageReceived', cb)` | `{ conversationId; profileId; message: string; author: string; userMemory: any }` | An inbound-message event | Nothing, if you registered the channel: this is one of the five slots registration takes |
| `tac.onInterrupt(cb)` | `(params: { conversationId; utteranceUntilInterrupt; durationUntilInterruptMs; session }) => Promise<void> \| void` | Same as the channel-level interrupt, plus the session | Same blindness to ambient context |
| `tac.onConversationEnded(cb)` | `(params: { session: ConversationSession }) => Promise<void> \| void` | The close boundary of a messaging conversation span | The voice hangup, for the orchestrated reason above |
| `voiceChannel.onInboundCallTwiml(cb)` | `(req: TwiMLRequest) => Promise<TwiMLOptions>` | Nothing timed, but this is where you inject per-call transport facts | Anything after the call connects |
| `voiceChannel.onCallStatus(cb)` / `.onAmd(cb)` / `.onRecording(cb)` | `(event: CallStatusEvent) => Promise<void> \| void`, and likewise for `AmdEvent` and `RecordingEvent` | Platform-reported durations as attributes on a call-level span | Anything sub-turn. Registration is also load-bearing rather than merely observational: with no handler registered the library omits the matching status callback parameter when it creates a call, so the platform has nowhere to post |
| `TACOptions.logger?: Logger` | `type Logger = pino.Logger`, consumed as `options.logger ?? createLogger({ name: 'tac' })` | A log bridge. Every channel derives from it by `.child(...)`, so one root logger reaches channel logging | This is the only zero-patch route to structured output, and it is undocumented upstream. Supplying your own instance drops the library's PII-scrubbing log hook unless you reinstall it; the scrubbing helpers are exported so that you can |
| `TACTool` and `defineTool` | `defineTool<TParams,TResult>(name, description, parameters, implementation: (params: TParams) => Promise<TResult> \| TResult)` | Tool spans, but only if you build them. The library never invokes a tool: `.implementation` is read at construction and inside the optional Agents-SDK adapter, and the format converters emit schema only | There is no `onToolCall`, no middleware and no tool context plumbing. The exported `ToolContext` type has no consumer in the bundle. Instrument by wrapping each tool or at your model runtime |
| `voiceChannel.getWebsocket(id): WebSocket \| null` | Returns the live socket | Every outbound frame, including the end-of-turn marker, if you wrap `send` on that instance | It looks private and is not. Wrapping an instance method is still a patch, just not a patch on the library's prototype |
| `startStreamTask` / `cancelStreamTask` / `completeStreamTask` / `hasActiveStreamTask` | All public on `VoiceChannel` | Turn-boundary bookkeeping, observable and drivable | The queue that serialises prompts, which is separate state |
| `handlePromptMessage` (prototype patch only) | private | The only place per-turn start is observable strictly upstream of your handler, including the memory recall the handler awaits before calling you | |
| `handleInterruptMessage` (prototype patch only) | private | The instant the stream task is cancelled, before your callback runs | |
| `handleWebSocketDisconnect` (prototype patch only) | private | Socket teardown ordering | |
| `TAC.handleMessageReady` and `setupChannelEventListeners` (prototype patch only) | private | The dispatch decision that turns your returned string into a single frame | The constructor is private, so the class cannot be usefully subclassed; the static factory is the only door |
| `promptQueues`, `streamTasks`, `webSocketConnections`, `voiceCallbacks` (prototype or instance patch only) | `private readonly` fields on `VoiceChannel` | Head-of-line queue depth and per-turn task identity | |

Two properties of that private state change how you read your own traces even though you never touch them. Prompt frames are chained: turn N plus one is dispatched as `previousPrompt.then(() => this.handlePromptMessage(...))`, so it cannot start until turn N's handler resolves, which makes your prompt-receipt timestamp a floor rather than the caller's stop. And the memory recall is awaited before your handler is called, so on a voice configuration that recalls once per conversation, a platform round trip lands in whatever span covers the interval before turn one, not inside turn one.

## The span model, and where the spec runs out

Nothing in the tree below is spec-named except the subtree the model SDK creates, and that is not an oversight. The GenAI conventions moved out of the main semantic-conventions repository and now live in [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), whose manifest reads `schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev` and `stability: development`. There is no tagged release and no GitHub release in that repository, so there is no citable stable version, only a commit or that development schema URL. Every document in it carries a Development status badge and every `gen_ai.*` attribute, span, metric, event and enum value in its tables is badged Development. The only Stable attributes on a GenAI span are borrowed from core semantic conventions: `error.type`, `server.address` and `server.port`.

More to the point for voice: there is no merged convention for speech to text, text to speech, audio latency, barge-in or realtime voice sessions. The entire merged voice surface is audio token usage (`gen_ai.usage.audio.input_tokens` and siblings) and `speech` as a well-known value of `gen_ai.output.type`. Two open pull requests propose the rest. [PR 390](https://github.com/open-telemetry/semantic-conventions-genai/pull/390) proposes `speech_to_text` and `text_to_speech` operations plus `gen_ai.agent.invocation.end_reason`, which is the standard-track name for the barge-in outcome. [PR 394](https://github.com/open-telemetry/semantic-conventions-genai/pull/394) argues that a live session streams user audio continuously while the server streams incremental output, so a generation cannot be represented by the client-timed inference span, and proposes a `generate_live_content` span anchored at first output, an opt-in `gen_ai.user_input.client` span bounded by voice-activity events, and a long-lived session modelled as events correlated by `gen_ai.conversation.id` rather than wrapped in a span. Neither is merged. Treat the voice span names below as one working shape that happens to converge with an unmerged proposal, not as conformance.

For multi-turn grouping the spec offers exactly one mechanism, the attribute `gen_ai.conversation.id`. There is no conversation span, no cross-turn parent-child convention, and no use of the general `session.id` attribute. A call-level root span is therefore an extension, and a reader who wants only spec-blessed grouping should stamp the call identifier on every turn's spans and stop there.

### One voice turn

```
conversation.voice                    call-level root, extension, no spec equivalent
│  input: { conversationId }
│  closed with: closedBecause, turns.count, turns.aborted,
│               caller.turn_total_ms, turn.ttfa_p50_ms, turn.ttfa_max_ms
│
├─ caller.turn                        parented to the ROOT, not to the turn
│    back-dated to the previous bot-output boundary, ended at prompt receipt
│    metadata: durationMs, and a "covers" string naming the blend
│
└─ turn.voice                         opened at prompt receipt, closed at the output boundary
     input.userText, metadata.channel
     metadata: prompt.name, prompt.version, prompt.label, model,
               tools.offered, tools.unknown
     metadata: turn.ttft_ms, turn.ttft_model_ms      written at first non-empty delta
     output: { text, toolCalls }
     metadata: tools.called, turn.total_ms, turn.total_model_ms, turn.aborted
     metadata: turn.ttfa_ms, turn.ending             written last, at the boundary
     level: ERROR plus statusMessage on a throw, which the wrapper must set itself
     │
     ├─ asr.final          zero-duration event at prompt receipt: transcriptChars, lang
     ├─ prompt.fetch       output { name, version, label }, metadata.durationMs
     ├─ memory.recall      output { chars }, metadata.durationMs, metadata.profileMs
     ├─ prompt.compose     output { systemChars, messages, historyMessages }
     ├─ tools.resolve      output { resolved[], unknown[], unavailable[] }
     ├─ llm.stream         a TIMER, not a parent. See below
     ├─ invoke_agent {model}     created by the model SDK, parented to turn.voice
     │    └─ chat {model}        one per provider call
     │         └─ execute_tool {name}
     ├─ tts.interrupted    event at interrupt receipt, barge-in only:
     │                     durationUntilInterruptMs, utteranceUntilInterrupt
     └─ tts.send           back-dated child, first delta to boundary:
                           durationMs, ending
```

Naming note that will cost you an afternoon if you get it backwards: `prompt.fetch` and `memory.recall` do not measure the platform's own recall. The platform recall was already awaited upstream of your handler. `memory.recall` here measures composing the memory block out of the payload you were handed, plus a profile lookup that is a real network call when uncached. Those two steps genuinely run concurrently because they are your work, in your handler, behind one `Promise.all`. Anyone reading a waterfall and concluding the platform recall is concurrent with the prompt fetch has mislabelled the platform's serial recall, which sits in the preceding interval.

Where the spec does have something to say, use it. `gen_ai.prompt.name` and `gen_ai.prompt.version` are real attributes, Conditionally Required when a named prompt template is used, with examples like `analyze-code` and `v2`, so a versioned-prompt story maps onto the spec directly rather than needing a private key.

### One messaging turn

```
conversation.sms
└─ turn.sms                      opened on callback entry, closed when the promise settles
     the same interior steps: prompt.fetch, memory.recall, prompt.compose,
     tools.resolve, llm.stream, and the invoke_agent subtree
```

Absent by construction, not by omission: there is no `asr.final`, no caller-side span, no text-to-speech spans, no time-to-first-audio and no turn-ending classification, because none of those signals exist on a path whose only output is one finished string. A first-token attribute on a messaging turn would be a fabrication.

## What the model SDK gives you, and what the wrapper must set

This split is the spine of the work. The AI SDK's OpenTelemetry integration emits GenAI-convention spans, and the attribute list below is from its own [telemetry documentation](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) as shipped with the installed version. Anything keyed on the older `ai.*` span names finds nothing.

| Span or attribute | Who sets it | Notes and caveats |
|---|---|---|
| `invoke_agent {modelId}`, kind INTERNAL | free | Covers the whole operation including every step and tool call |
| `chat {modelId}`, kind CLIENT, one per provider call | free | Nested under `invoke_agent` |
| `execute_tool {toolName}`, kind INTERNAL | free | Nested under the step span. You get this only for tools the model runtime executes; a tool the Agent Connect layer hands you is a schema, and the library never invokes it |
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` | free | The two Required attributes on an inference span are the first two |
| `gen_ai.agent.name` | free, from the `functionId` you pass | This is the one place your channel label reaches a spec attribute, so set `functionId` per channel |
| `gen_ai.request.temperature`, `max_tokens`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `stop_sequences`, `seed` | free when you send them | If you pass no provider options, these arrive empty, and an empty request-parameter set is a finding rather than a bug |
| `gen_ai.response.finish_reasons`, `gen_ai.response.id`, `gen_ai.response.model` | free | |
| `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens` | free | The cache attributes are what let you separate a cold first turn from warm follow-ons |
| `gen_ai.client.operation.duration`, in seconds | free | |
| `gen_ai.client.operation.time_to_first_chunk`, in seconds | free | Right name, right unit, wrong signal. The spec defines that exact string as a histogram metric; its span attribute for the identical measurement is `gen_ai.response.time_to_first_chunk`. If you want spec-clean spans, alias the value across with no conversion. The SDK's legacy mode emits the same measurement in milliseconds under a different key, so moving between its two modes changes units by a thousand |
| `gen_ai.client.operation.time_per_output_chunk`, in seconds | free | |
| `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | free when input and output recording is on | The spec's default is that instrumentations should not capture these and should offer an opt-in. If you turn them on, prompts and completions leave your process in full, and any scrubbing you wrote for your own spans does not cover them. Say that accurately in your own documentation rather than implying the traces are clean |
| `gen_ai.execute_tool.duration`, in seconds | free | |
| Call-level root span, its open and close boundaries, and its close reason | wrapper | No spec equivalent exists. The spec's only grouping mechanism is a flat conversation id attribute |
| `gen_ai.conversation.id` | wrapper | Conditionally Required when readily available, and it is: the call identifier arrives on the `setup` payload |
| Turn span, its name, its start instant and its end instant | wrapper | On voice both instants are yours. On messaging only the start is |
| Caller-side span and its back-dating | wrapper | Uncovered by the spec today; closest proposal is the unmerged user-input span in PR 394 |
| Transcript-received event and transcript size | wrapper | |
| Prompt fetch, memory composition, prompt composition and tool resolution steps | wrapper | These are your preamble. Measured as a ceiling of 84 ms across 33 generations in one day with one caller and one model, which makes it a bound on your own overhead and not a benchmark of anything |
| Time to first token, measured on the first non-empty text delta | wrapper | Do not reuse the SDK's first-chunk number for this. A turn that opens with a tool call streams tool-argument chunks with nothing audible for hundreds of milliseconds, so the SDK's first chunk and the caller's first word are different events |
| Two time origins under two attribute prefixes, one turn-relative and one stream-relative | wrapper | Mixing them under one prefix makes first-token-later-than-total reachable, and it happens on a prompt-cache miss |
| Server-side time-to-first-audio proxy | wrapper | Name it honestly as a floor. It cannot see synthesis or the media leg |
| Bot-output span, back-dated from the first delta to the output boundary | wrapper | |
| Turn-ending classification, including the barge-in case | wrapper | The standard-track name for this is proposed in PR 390 and is not merged |
| Error status on the turn span | wrapper | If you keep the span open past your callback so you can end it yourself, the tracing helper's own error marking no longer runs, and status writes after end are dropped in silence. A turn whose prompt fetch threw exported an unset status where the helper's own ending would have exported an error status with a message |
| Tool spans for tools the library supplies | wrapper | Wrap each tool around its own `implementation`, or instrument at the model runtime. There is no hook |

## The tiling property

A voice trace is worth having only if the timeline accounts for the call. The first version of this instrumentation did not. On one real call of 57.5 seconds with six turns, the spans covered 12.2 seconds and left 45.3 seconds unexplained. That reads to anyone opening the trace as "the instrumentation does not work," when in fact every span was correct and the intervals between them belonged to nobody.

The shape that fixes it is two span families that alternate. A turn span covers prompt receipt to the end-of-turn marker leaving the socket. A caller-side span covers every instant between two turns, back-dated to the previous output boundary and closed at the next prompt receipt. On one real call after the change, the root covered 42675 milliseconds with 86 observations across six turns, and the gap between every consecutive root child was zero milliseconds across all eleven boundaries. That is one call, one caller, one direction, so read it as a proof that the shape closes rather than as a distribution.

Two residuals survive, and both are explainable rather than swept up. At the head, turn one is back-dated by one millisecond, because the prompt-receipt timestamp is captured before the root span is created lazily, and that sign is the correct one. At the tail, 2394 milliseconds separate the last end-of-turn marker from socket close, which is the final reply still playing plus the hangup, and nothing running in this process can see inside it. Getting that number properly needs call-level insights or media-stream marks, both out of scope here.

Why it took work is the interrupt path. The library dispatches the interrupt callback synchronously right after cancelling the stream task, while your turn is still draining, and a turn's output text, tool list and total model time are written during that drain. Ending the turn span in the interrupt handler therefore drops all three writes with no error, because attribute writes after span end return early. A barged-in turn showed up with no output text and no tool list, on the one turn ending that is ordinary operation on a phone call. The mechanism that works keeps a small per-call registry both handlers can reach, has the interrupt handler park the boundary rather than close the span, and has the prompt handler's `finally` close it after the drain on all four exits. First boundary wins, so a second interrupt frame changes nothing. The registry cannot live in the prompt handler's closure precisely because the interrupt arrives on its own frame with no ambient context, which is the same reason the interrupt-time event must name its parent explicitly or it becomes the root of a second trace per barge-in.

The caveat that must travel with the headline number: the caller-side span measured 27622 of those 42675 milliseconds, which is 65 percent of the call, and it is a blend. It contains bot audio playback, the caller actually speaking, speech endpointing, and on turn one the platform's memory recall, which the library awaits before your handler runs. It is not a measurement of how long the caller talked, and presenting it that way is the easiest wrong conclusion available from this trace. What proves the 65 percent is not your streaming is the bot-output span, which ran 150 to 804 milliseconds per turn across those same six turns of that one call.

### The two relationships that are not what they look like

The first is the caller-side span's parent. It hangs off the call-level root, not off the turn it precedes, and that is deliberate: it ends where the turn begins, so nesting it under the turn would draw a child that starts before and ends at its parent's start. Because voice turns are minutes of independent WebSocket frames with no async context held open across them, the caller-side span also re-extracts the serialised trace parent from the root rather than inheriting the ambient context, even though the ambient context at that moment is the turn span.

The second is the model call's parent. A span named for the model stream sits in the tree above the model SDK's `invoke_agent` span and looks like its parent. It is not. Starting an observation without making it the active context creates the span but does not enter it, so `invoke_agent` names the turn span as its parent, exactly as the prompt-fetch step does. Verified by reading the recorded parent span identifiers, not by looking at the rendered waterfall, which draws something that reads as nesting. The model-stream span is a timer running alongside the model call. Do not draw or assert containment between them, and if you publish the tree, publish it this way, because an earlier revision of this project's own notes had it wrong.

One more relationship worth stating because it is a negative result rather than a shape: the time-to-first-audio proxy landed within zero to three milliseconds of time-to-first-token on all six turns of that call. That is not a measurement of audio. It proves that nothing queues between the model and the socket, which follows from the library's synchronous per-chunk send, and it remains blind to synthesis and playback, which is the part the caller hears.

## Open items in this section

The barge-in branch of this span model has not been exercised on live traffic. Both real calls measured had zero aborted turns and no interrupt event, so the parking mechanism above is proven by the test suite and a diagnostic script rather than by a caller talking over the agent. Treat it accordingly until one call does.

The trace shapes here were verified against the underlying columnar store and the tracing UI rather than through a read API, because the tracing backend deployment in use exposes no public read API for traces and returns a not-found status meaning "disabled" rather than "no data." That is a methodological note about how the parent-identifier claims were checked, and it matters because an in-memory span exporter cannot exercise the real export pipeline's filtering.

Version drift to keep in view. The extension surface above is 2.2.0. Upstream 2.3.0 adds one additive callback for keypad digits, which in 2.2.0 fail inbound validation and are dropped with a debug log, and refactors the voice conversation-init block into a shared closure so a keypress initialises a conversation the same way a prompt does. Nothing on the prompt path changed. The callback types are exported and not marked internal, which in that repository's own convention is a deliberate signal that a member is consumer-facing, but there is no written stability, semantic-versioning or deprecation policy anywhere in it, and the published API reference link in its README currently returns not-found. A wrapper over these callbacks is the closest thing to supported that the library offers, and it is an unwritten contract rather than a guarantee. A private staging repository openly aimed at reworking the voice provider layer is the part of that contract most likely to move.

## Citations

- https://github.com/twilio/twilio-agent-connect-typescript
- https://github.com/twilio/twilio-agent-connect-typescript/releases/tag/v2.3.0
- https://github.com/twilio/twilio-agent-connect-typescript/pull/96
- https://github.com/twilio/twilio-agent-connect-typescript/pull/95
- https://github.com/twilio/twilio-agent-connect-typescript/issues/93
- https://github.com/twilio/twilio-agent-connect-typescript/issues/94
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/lib/logger.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/lib/tac.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/typedoc.json
- https://github.com/open-telemetry/semantic-conventions-genai
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/manifest.yaml
- https://github.com/open-telemetry/semantic-conventions-genai/pull/390
- https://github.com/open-telemetry/semantic-conventions-genai/pull/394
- https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.44.0
- https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
- https://www.twilio.com/docs/voice/conversationrelay/best-practices
- https://www.twilio.com/docs/voice/voice-insights/api/call/details-conversation-relay-events
- https://pages-4296.twil.io/agent-scaffold-architecture
- Symbols read from the shipped twilio-agent-connect 2.2.0 bundle: MessageReadyCallback, InterruptCallback, ConversationEndedCallback, VoiceChannelEvents.onPrompt, VoiceChannelEvents.onInterrupt, VoiceChannelEvents.onSetup, MessagingChannelEvents.onMessageReceived, BaseChannel.on, MessagingChannel.on, VoiceChannel.on, VoiceChannel.sendResponse, VoiceChannel.sendStreamingResponse, VoiceChannel.handleWebSocketConnection, VoiceChannel.getWebsocket, VoiceChannel.startStreamTask, VoiceChannel.cancelStreamTask, VoiceChannel.completeStreamTask, VoiceChannel.hasActiveStreamTask, VoiceChannel.handlePromptMessage, VoiceChannel.handleInterruptMessage, VoiceChannel.handleWebSocketDisconnect, VoiceChannel.promptQueues, VoiceChannel.streamTasks, VoiceChannel.webSocketConnections, VoiceChannel.voiceCallbacks, TAC.handleMessageReady, TAC.setupChannelEventListeners, TAC.registerChannel, TACOptions.logger, createLogger, InboundCallTwimlHandler, CallStatusHandler, AmdHandler, RecordingHandler, TACTool, defineTool, ToolContext, ToolFunction, WebSocketMessageSchema, PromptMessageSchema, InterruptMessageSchema, scrubPii, scrubObject, maskPhone, maskEmail, maskAddress, redactTwimlParameters

## Unverified

- The barge-in branch of the span model is unproven on live traffic. Both measured real calls recorded zero aborted turns and no interrupt event, so the park-the-boundary mechanism is evidenced only by the test suite and a diagnostic script.
- Every measured number in the tiling discussion (42675 ms root, 86 observations, six turns, zero-millisecond gaps across eleven boundaries, 27622 ms caller-side total, 150 ms to 804 ms bot-output spans, the minus-one-millisecond head residual, the 2394 ms tail residual) comes from a single call by a single caller in one direction. The 57.5 s / 12.2 s / 45.3 s before-figures come from one earlier call.
- The 84 ms preamble ceiling and the claim that time-to-first-chunk accounts for the generation span almost exactly rest on 33 generations from a single day, a single caller and a single model. Not a benchmark.
- The zero-to-three-millisecond agreement between the time-to-first-audio proxy and time-to-first-token is six turns of one call.
- The AI SDK span tree is stated as invoke_agent to chat to execute_tool, from the installed SDK's own telemetry documentation. An intermediate step-numbered span appears in this project's earlier notes; whether that is a separate span or a rendering artifact of the tracing UI was not settled.
- The exact set of gen_ai.* attributes listed as arriving free is read from the installed AI SDK telemetry documentation, not from a diff of a live trace against that list. Individual attributes may be absent for a given provider or call shape.
- The claim that supplying a custom logger bypasses the library's PII-scrubbing log hook is derived from reading the logger factory and the assignment site, not exercised at runtime. Likewise, whether a caller-supplied logger reaches every logging site was not traced to every construction site; at least two internal clients fall back to their own logger when constructed without one.
- Whether the two open OpenTelemetry GenAI voice pull requests have since been merged, closed or superseded was not rechecked at publication time. One of them was active the day before the source read.
- The GenAI conventions repository has no tagged release, so the version cited is a development schema URL plus a commit date rather than a release.
- ConversationRelay publishes no WebSocket idle timeout, no deadline for the first text frame after a prompt and no time-to-first-token target. That is an absence across the pages fetched, not a documented guarantee that no limit exists.
- Whether the platform discards queued-but-unspoken tokens on an interrupt is not stated in any fetched documentation, so the truncation point is inferred from the utterance field on the interrupt frame.
- Whether the platform buffers tokens to sentence boundaries before synthesis is inferred from an insights metric definition, not from a stated protocol rule.
- The prompt-frame chaining and the pre-handler memory recall are read from the shipped bundle; their effect under an added network hop in the handler was not exercised.
- The upstream 2.3.0 delta is taken from release notes, the pull request body and the export barrel rather than from a diff of two installed bundles.
- The claim that a private upstream staging repository targets the voice provider layer rests on that repository's public name and description only.
