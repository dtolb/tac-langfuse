# Existing OTEL instrumentation in tac-langfuse

# OTel instrumentation already in tac-langfuse — inventory for a how-to page

Installed versions (all claims below are against these): `ai@7.0.93`, `@langfuse/otel@5.11.0`, `@langfuse/tracing@5.11.0`, `@langfuse/vercel-ai-sdk@5.11.0`, `@opentelemetry/sdk-node@0.222.0`, `twilio-agent-connect@2.2.0`.

## 1. The SDK boot entry point

`server/obs/instrumentation.ts` — loaded as `node --import ./server/obs/instrumentation.ts … server/index.ts` (`instrumentation.ts:4`). Three lines of substance:

- `new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] })` + `sdk.start()` (`instrumentation.ts:34-40`).
- `registerTelemetry(new LangfuseVercelAiSdkIntegration())` (`instrumentation.ts:45`) — AI SDK 7 is callback-based telemetry, so **without this line model calls produce no spans at all** (`instrumentation.ts:42-44`).
- Degrades silently: no `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`BASE_URL` → registers nothing, writes one stderr line, app still runs (`instrumentation.ts:23-32`). It writes to stderr, not the app logger, deliberately — importing `logging.ts` here would pull half the app in before patching (`instrumentation.ts:28-29`).

Two ordering facts a reader needs and would otherwise get wrong:
- **`--import`, not a top-of-file import.** ESM hoists all imports, so `import './obs/instrumentation.ts'` at the top of `index.ts` still evaluates after/interleaved with the modules it must patch (`instrumentation.ts:10-13`).
- **Not Next's `instrumentation.ts` convention.** Every model call is in the agent process; registering in the Next process yields an empty Langfuse with nothing to explain it (`instrumentation.ts:6-8`).

## 2. The one rule everything else follows

`LangfuseSpanProcessor` **filters**: `isDefaultExportSpan = isLangfuseSpan(scope === LANGFUSE_TRACER_NAME) || isGenAISpan(any attribute key starting 'gen_ai.') || isKnownLLMInstrumentor(scope)` (`node_modules/@langfuse/otel/dist/index.mjs:284-300`, wired at `:380`). So a span from `trace.getTracer(x).startActiveSpan(...)` is created fine, an in-memory exporter sees it, and it is **silently dropped** on the way to Langfuse (`server/obs/spans.ts:5-15`, measured during spike S1: a `turn.voice` vanished while AI SDK spans arrived). Every custom span therefore goes through `@langfuse/tracing`'s `startObservation` / `startActiveObservation`, and `server/obs/spans.ts` is the repo's only sanctioned factory (`server/agent/spans.ts:6-18`).

Second rule with the same failure mode: **an unended span reaches Langfuse not at all** — repeated at `spans.ts:106`, `conversations.ts:10-20`, `voice-timeline.ts:24-27`, `run-turn.ts:482-485`.

Third rule, non-obvious and pure vendor behaviour: `createObservationAttributes` destructures a **fixed** key set (`input`, `output`, `metadata`, `level`, `statusMessage`, `version`, `environment`, `prompt`, plus generation-only keys) and drops everything else silently, so `{'turn.ttfa_ms': 4}` at top level reaches nothing. Custom attributes must go under `metadata`, which flattens one level to `langfuse.observation.metadata.<key>` (`spans.ts:136-148`, `run-turn.ts:262-267`). And **a `null` or empty-string metadata value is dropped, not recorded as null** (`_flattenAndSerializeMetadata` keeps a key only `if (serialized)`); `false`/`0` survive (`spans.ts:143-147`).

## 3. Full span tree — one voice turn

Root created lazily on the first turn by the conversation registry, not at `setup` (`voice.ts:888-891`, `conversations.ts:117-139`):

```
conversation.voice                        startConversationSpan  (spans.ts:108; name from tac.ts:379)
│   input:    { conversationId }                                  conversations.ts:95
│   metadata (written once, at close, conversations.ts:111):
│     closedBecause: 'ended' | 'idle past <ttl>ms' | 'evicted at the conversation cap' | 'shutdown'
│     turns.count, turns.aborted, caller.turn_total_ms,
│     turn.ttfa_p50_ms, turn.ttfa_max_ms                          voice-timeline.ts:287-295 via onClose (tac.ts:397)
│
├─ caller.turn                            startSpanUnder(traceparent, …) — voice.ts:480-490
│    back-dated to the previous bot-output boundary, ended at promptAt
│    metadata: durationMs, covers: 'bot playback + caller speech + ASR endpointing (+ memory recall on turn 1)'
│    parented to the ROOT, not the turn, on purpose: it ends where the turn begins  voice.ts:476-478
│
└─ turn.voice                             withTurnSpan('turn.voice', traceparent, …)  voice.ts:432
     { startTimeMs: promptAt, endOnExit: false }                  voice.ts:852
     attributes, in write order:
       input.userText, metadata.channel                           run-turn.ts:190
       metadata['prompt.name'|'prompt.version'|'prompt.label'],
       metadata.model, metadata['tools.offered'], metadata['tools.unknown'] run-turn.ts:297-305
       prompt: {name, version, isFallback:false}  (top-level key, real versions only) run-turn.ts:306-308
       metadata['turn.ttft_ms'], ['turn.ttft_model_ms']  at first token   run-turn.ts:431
       output {text, toolCalls}; metadata['tools.called'],
         ['turn.ttft_ms'], ['turn.ttft_model_ms'], ['turn.total_ms'],
         ['turn.total_model_ms'], ['turn.aborted']                 run-turn.ts:545-555
       level:'ERROR' + statusMessage on a throw                    voice.ts:815
       LAST, overwriting: metadata['turn.ttfa_ms'], ['turn.total_ms'],
         ['turn.aborted'], ['turn.ending']                         voice-timeline.ts:240-262
     ├─ asr.final                event, zero-duration at promptAt  voice.ts:501-505
     │    metadata: transcriptChars, lang (null today — TAC 2.2.0 drops `lang`, tac.ts:449-457)
     ├─ prompt.fetch             timeStep; output {name, version, label} + metadata.durationMs  run-turn.ts:205-209
     ├─ memory.recall            timeStep; output {chars} + metadata.durationMs                run-turn.ts:210-220
     │    (runs concurrently with prompt.fetch — one Promise.all, run-turn.ts:204)
     ├─ prompt.compose           output {systemChars, messages, historyMessages}                run-turn.ts:231-248
     ├─ tools.resolve            output {resolved[], unknown[], unavailable[]}                  run-turn.ts:251-259
     ├─ llm.stream               startStep; input {model, tools}                                run-turn.ts:353-356
     │    output {chars, deltas, steps}; metadata {ttftMs, totalMs, aborted}; ended inside `done` run-turn.ts:556-560
     ├─ invoke_agent <model>     AI SDK, free                     (see §4)
     │  ├─ step 1 ─ chat <model>  GENERATION
     │  │        └─ <tool name>   TOOL
     │  └─ step 2 ─ chat <model>  GENERATION
     ├─ tts.interrupted          event at interruptAt, barge-in only            voice.ts:982-993
     │    metadata: durationUntilInterruptMs, utteranceUntilInterrupt
     └─ tts.send                 back-dated child, firstTokenAt → boundary      voice-timeline.ts:231-238
          metadata: startedBecause:'first text token sent', durationMs,
                    ending: 'last-token'|'fallback'|'interrupt'|'no-output'|'evicted'
```

**`llm.stream` does NOT parent the model call.** Confirmed against ClickHouse `parent_span_id`: `invoke_agent` names the **turn** span as its parent, exactly like `prompt.fetch` does, because `startStep` uses `startObservation`, which creates an observation without making it the active context (`docs/HANDOFF.md:377-398`, mechanism at `spans.ts:290-298`). `llm.stream` is a timer running alongside the model call. Do not draw or assert `llm.stream > invoke_agent`.

Real measured voice trace shape (T15, `docs/HANDOFF.md:1936-1947`): root 42675 ms fully tiled by alternating `caller.turn` / `turn.voice` with 0 ms between them; `caller.turn` was 27622 ms = 65% of the call; `tts.send` 150–804 ms per turn.

## 4. Full span tree — one SMS turn

```
conversation.sms                       spanName from tac.ts:331; same root attrs minus the voice stats
                                       (voice is the only channel passing onClose — conversations.ts:69-72)
└─ turn.sms                            withTurnSpan('turn.sms', traceparent, …)  messaging.ts:97
     default options: endOnExit true, no startTimeMs → the vendor ends it when the callback settles
     attributes: identical run-turn.ts set as above (190, 297-309, 431, 545-555)
     ├─ prompt.fetch / memory.recall / prompt.compose / tools.resolve / llm.stream   run-turn.ts, as above
     └─ invoke_agent <model> → step N → chat <model> (+ TOOL children)
```
No `asr.final`, no `caller.turn`, no `tts.*`, no `turn.ttfa_ms`, no `turn.ending` — those exist only where a timeline is wired (`tac.ts:372-376`). The bench is a third, identical shape under `conversation.bench` / `turn.bench` (`conversations.ts:88`), which is the one drawn out attribute-by-attribute in `docs/HANDOFF.md:370-386`.

## 5. Free from the AI SDK vs hand-set here — the spine

**Free (repo writes zero attributes on these spans):**
- Span names and hierarchy `invoke_agent <model>` (AGENT) → `step N` → `chat <model>` (GENERATION) → tool spans. OTel GenAI semantic conventions, **not** `ai.*`; anything keying on `ai.streamText` (a v6 name) finds nothing (`server/agent/model/openai.ts:11-13`).
- All `gen_ai.*` attributes, including `gen_ai.client.operation.time_to_first_chunk` (**seconds**), `gen_ai.client.operation.duration`, `…time_per_output_chunk`, and `gen_ai.usage.{input_tokens, output_tokens, cache_read.input_tokens, cache_creation.input_tokens}` (`docs/HANDOFF.md:1744-1751`, `:1862`). Measured across 33 generations: `time_to_first_chunk` accounts for the generation span almost exactly, framework overhead 84 ms (`docs/HANDOFF.md:1750-1753`, `:1761-1768`).
- Full prompt and completion text on the model spans. **Repo scrubbing does not cover these** — `scrubFields` covers only spans this repo creates, so real transcripts do reach Langfuse (`spans.ts:30-42`). Stated as a deliberate decision, not an oversight.

**Only three things the repo hands the SDK** (`openai.ts:147-172`):
- `telemetry: { isEnabled: true, functionId: 'turn.<channel>', includeRuntimeContext: { langfusePrompt: true } }` — `functionId` comes from `run-turn.ts:328` and is what separates voice from SMS in Langfuse.
- `runtimeContext: { langfusePrompt: promptLink }` — the prompt-version link.
- Nothing else; no `providerOptions`, so `model_parameters` is `{}` on all 33 generations (`docs/HANDOFF.md:1856-1860`).

**The v6→v7 trap, which is the single most page-worthy item** (`openai.ts:59-77`): the ≤v6 recipe was `experimental_telemetry.metadata.langfusePrompt = prompt.toJSON()` (a **string**). Both halves are wrong on ai@7 and neither errors: (1) `TelemetryOptions` in ai@7 has **no `metadata` field at all** — observation metadata comes from `runtimeContext` keys opted in via `telemetry.includeRuntimeContext`, and `filterIncludedContext` drops any key not set to exactly `true`; (2) the integration's `normalizePrompt` requires a **plain object** with `name: string`, `version: number`, and `ChatPromptClient.toJSON()` returns a `JSON.stringify` string, so it fails `isPlainObject` and the link is dropped. Symptom: a prompt version whose Metrics tab stays empty, which reads as a Langfuse problem. Fix is `langfusePromptLink` (`openai.ts:82-99`): parse the string back, zod-validate, hand over an object, preserve `isFallback` when present, return `undefined` rather than throw on anything unparseable.

**Hand-set, everything else** — every span in §3/§4 except the `invoke_agent` subtree, and every attribute listed on them. Two of those are hand-measured *because* the SDK number is the wrong number:
- `turn.ttft_ms` is measured on the **first non-empty text delta**, not the SDK's first chunk, because a turn that opens with a tool call streams tool-input chunks with no audible output for hundreds of ms (`obs/first-token.ts:9-13`).
- Two time origins under two prefixes: `turn.ttft_ms`/`turn.total_ms` are turn-relative, `turn.ttft_model_ms`/`turn.total_model_ms` are stream-relative. Mixing them under one prefix made `ttft_ms > total_ms` reachable and it happened — "first token at 500 ms, response complete at 360 ms" on a prompt-cache miss (`run-turn.ts:381-411`).
- `turn.ttfa_ms` is a server-side **proxy** and is named honestly as a floor: it cannot see Twilio TTS synthesis or the media leg (`voice-timeline.ts:242-244`, `voice.ts:350-356`).

One hand-set attribute **does not work and is kept anyway**: the top-level `prompt: {name, version}` link on the turn span. Attributes are set correctly (verified against an in-memory OTel exporter) and arrive intact, but Langfuse v4's OTel ingestion computes `promptName`/`promptVersion` as `type === GENERATION ? … : null`, and this observation's type is `span`. Checked live: `events_core` has `prompt_name = ''` / `prompt_version = NULL` for `turn.bench` while the sibling `chat <model>` GENERATION carries the resolved link (`run-turn.ts:278-292`).

## 6. Exporter wiring

Everything comes from the `LangfuseSpanProcessor` defaults; the repo passes **no arguments** (`instrumentation.ts:38`).

- Exporter: `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-http` (`otel/dist/index.mjs:14`, constructed `:358`). OTLP/HTTP, protobuf-over-HTTP — not gRPC.
- Endpoint: `` `${baseUrl}/api/public/otel/v1/traces` `` (`:359`), `baseUrl` from `LANGFUSE_BASE_URL` → `LANGFUSE_BASEURL` → `https://cloud.langfuse.com` (`:338-341`). Here `LANGFUSE_BASE_URL=http://localhost:3100` (`.env.example:237`).
- Auth: `Authorization: Basic base64(publicKey:secretKey)`, plus `x-langfuse-sdk-name`, `x-langfuse-sdk-version`, `x-langfuse-public-key` (`:354`, `:360-365`). Keys from `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` (`.env.example:238-239`).
- Timeout: `LANGFUSE_TIMEOUT` seconds, default 5 → `timeoutMillis: 5000` (`:356`, `:367`).
- Batching: `BatchSpanProcessor` with `maxExportBatchSize` from `LANGFUSE_FLUSH_AT` and `scheduledDelayMillis` from `LANGFUSE_FLUSH_INTERVAL × 1000` (`:369-372`). Neither var is in `.env.example`, so both are `undefined` and the OTel `BatchSpanProcessor` defaults apply. `exportMode: 'immediate'` would swap in `SimpleSpanProcessor` — not used here.

**Short-lived process / shutdown, three layers:**
1. `flushTelemetry()` (`spans.ts:339-348`) must go through `trace.getTracerProvider().getDelegate()?.forceFlush()`. `trace.getTracerProvider()` returns a `ProxyTracerProvider` with **no** `forceFlush`, so the tempting `trace.getTracerProvider().forceFlush?.()` is a silent no-op whose symptom is an empty Langfuse with no error (`spans.ts:331-338`). `forceFlush` flushes **without** tearing the provider down, so spans ended later still export.
2. Server shutdown is one Fastify **`preClose`** hook, and `preClose` specifically (`server/index.ts:78-83`). `onClose` would be wrong twice: avvio's `onClose` queue is LIFO so ours would run after `server.close()`, and `obs.shutdown()` is what ends the SSE responses `server.close()` waits on — a deadlock; and once TAC owns the instance, `fastify-graceful-shutdown`'s 10 s watchdog `process.exit(1)`s regardless, skipping the flush (`index.ts:59-73`). Order inside is: end SSE → end conversation roots (`tacShutdown`) → **then** `flushTelemetry()`, because flushing first ships every turn while dropping the root they hang from (`index.ts:74-77`).
3. `instrumentation.ts` registers **`beforeExit` only** and explicitly forbids adding SIGTERM/SIGINT there (`instrumentation.ts:65-86`). A `--import` preload's signal listener runs *before* the app's own (Node dispatches in registration order), so a SIGTERM handler calling `sdk.shutdown()` raced `fastify.close()`: whoever won, the root spans were ended **after** the provider was torn down, and a span ended on a dead provider is silently dropped. `beforeExit` remains for exits that were never signalled (empty event loop, a script that just finishes) — which is what the `scripts/verify-*` short-lived processes rely on, plus an explicit `await flushTelemetry()` as their last statement (`scripts/verify-telemetry.ts:228`, `scripts/verify-turn.ts:261-263`).

## 7. Context propagation

**Across the WebSocket turn boundary: a serialised W3C `traceparent`, not AsyncLocalStorage.** A voice conversation is minutes of independent WebSocket frames, so there is no async context to hold open (`spans.ts:17-21`). `startConversationSpan` starts the root and immediately `propagation.inject`s its span context into a carrier, returning the `traceparent` string and **not** holding the span active (`spans.ts:108-133`). Each turn rehydrates with `propagation.extract(context.active(), {traceparent})` and runs inside `context.with(parentCtx, () => startActiveObservation(...))` (`spans.ts:225-249`).

**The carrier is this repo's own registry, deliberately in preference to TAC's `session.metadata`.** `conversations.ts:22-28` states why: `session.metadata` survives until CO marks the conversation CLOSED, while the registry sweeps on a TTL and **ends** the root span — so reading metadata first would rehydrate turn N+1 as a child of an already-ended, already-exported root, i.e. a root whose duration does not cover its children. Both channels pass `sessionMetadata: {}` into `runTurn` for exactly this reason (`voice.ts:519-521`, `messaging.ts:106-109`).

**`context.with` is used in exactly two places**, both in `spans.ts` (`:236` and `:275`), and the AI SDK inherits the ambient context from being called inside the `withTurnSpan` callback. That is why the callback must wrap the **entire** handler including the await on sending the response — otherwise the AI SDK's spans are created outside the context and land in a different trace (`spans.ts:222-224`). It is also why `runTurn` never creates or ends the turn span: `withTurnSpan` ends when its callback settles, and `runTurn` returns `{tokens, done}` for the caller to drain afterwards, so a span created inside would close before the first token (`run-turn.ts:5-21`).

**Where propagation breaks, and the two workarounds:**
1. **TAC's `interrupt` callback has no ambient context at all** — TAC dispatches it from its own WebSocket message handler. A bare `startObservation` there becomes the **root of its own trace**, i.e. a second trace per barge-in (`spans.ts:71-79`, restated `voice.ts:969-977`). Workaround: `TimelineSpan.event`/`.child` parent **explicitly** by `parentSpanContext` read eagerly from `observation.otelSpan.spanContext()` — a plain getter that stays valid after `end()`, which is what lets `tts.send` be minted from an instant already past (`spans.ts:81-89`, `:153-177`).
2. **`startObservation` does not make itself active.** So `llm.stream` does not contain `invoke_agent` (§3), and any span started inside the memory port would attach to the turn as a *sibling* of `memory.recall` rather than a child — which is one of the three reasons `memory-compose.ts` creates no span at all (`memory-compose.ts:141-144`).
3. **`caller.turn` re-extracts the traceparent even though the ambient context is the turn span**, because it must parent to the root: it ends where the turn begins, and nesting it would draw a child longer than its parent (`spans.ts:251-262`, `voice.ts:476-478`). `startSpanUnder` with `traceparent === undefined` falls back to `context.active()`, which is the documented degradation when tracing is off (`spans.ts:259-262`).
4. **Nothing this process does can wrap TAC's memory Recall.** `handlePromptMessage` awaits `retrieveMemoryIfEnabled` *before* calling `onPrompt`, and voice runs `memoryMode: 'once'` — so on turn 1 a Conversation Orchestrator round-trip lands inside the *preceding* `caller.turn`, not inside `turn.voice` (`voice.ts:394-401`, `tac.ts:417-421`).

## 8. Interrupt / barge-in: the actual mechanism

The naive version ended the turn span in the interrupt handler. TAC invokes that callback **synchronously right after `cancelStreamTask`**, while `runTurn`'s `done` still needs the stream drain — and `run-turn.ts` writes `output`, `tools.called` and `turn.total_model_ms` *inside* `done` (`run-turn.ts:545-555`). `Span.setAttribute` returns early once `_isSpanEnded()`, so those writes are dropped in silence: a barged-in turn showed in Langfuse with no output text and no tool list, on the one ending that is ordinary operation on a call (`voice-timeline.ts:82-95`, `voice.ts:931-938`).

The mechanism, three pieces:

1. **A per-call registry both handlers can reach.** `createVoiceTimeline` (`voice-timeline.ts:182`) is keyed by conversation id and holds the live `TimelineSpan`, `promptAt`, `firstTokenAt` and a parked `recordedClose` (`:163-170`). It cannot live in the prompt handler's closure precisely because the interrupt arrives on its own frame (`voice.ts:332-337`). It is deliberately vendor-free — one type import from `spans.ts` and nothing else (`voice-timeline.ts:18-21`).
2. **The interrupt handler PARKS, it does not close.** `handleVoiceInterrupt` stamps `interruptAt` on its first line, reaches the span via `timeline.liveTurn(conversationId)` (null is normal — CR can interrupt the TwiML welcome greeting), writes the `tts.interrupted` event, then calls `recordBoundary({atMs: interruptAt, aborted: true, ending: 'interrupt'})` (`voice.ts:944-1001`). `recordBoundary` sets `live.recordedClose` — **first boundary wins**, a second interrupt frame changes nothing — and moves `lastBotOutputAt` *immediately*, so a next prompt arriving before the straggling handler's `finally` still draws `caller.turn` from the interrupt (`voice-timeline.ts:350-359`).
3. **The prompt handler's `finally` closes it, after `await done`.** `withTurnSpan(..., {startTimeMs: promptAt, endOnExit: false})` keeps the observation open past the callback (`voice.ts:852`), and a `finally` calls `timeline.completeTurn(conversationId, {atMs: boundaryAt ?? Date.now(), …}, span)` on all four exits — abort branch, handoff branch, normal fall-through, throw (`voice.ts:817-849`). `closeLive` prefers `live.recordedClose ?? close`, so the turn ends **at the interrupt instant** however it is closed (`voice-timeline.ts:207-223`).

Four consequences the page should carry:

- **`endOnExit: false` makes error marking the repo's job.** `@langfuse/tracing`'s `wrapPromise` does `span.setStatus({code: ERROR, message})` *then* ends; `setStatus` is also dropped after end, so a caller that ends in its own `finally` loses it. Measured: a turn whose `prompts.get` throws exported `status {code: 0}` (UNSET) where the vendor's own ending exported `{code: 2, message}`. Hence the explicit `span.update({level:'ERROR', statusMessage})` (`spans.ts:203-213`, `voice.ts:796-816`).
- **`ownerSpan` is passed to `completeTurn`/`markFirstToken` and is not decoration.** The timeline is keyed by conversation id and a handler can outlive the next turn's start (TAC serialises via `promptQueues`, but `handleWebSocketDisconnect` deletes that queue, `shutdown` clears it, and CO reuses one conversation id per profile). Measured with two overlapping handlers on one id: the straggler's `finally` closed turn B at turn A's boundary — B exported at 10 ms with A's `turn.ttfa_ms`, `tts.send` at 0 ms, and B's own close silently no-opping (`voice-timeline.ts:105-113`, `:337-346`).
- **`endOnExit: false` does not change the recorded times** — with the default `true` plus a caller that ends the span itself, times are identical, because `Span.end` answers a second call with a `diag.error` and returns. It is still the right flag: it stops one `diag.error` per turn and makes the end time ours by construction (`spans.ts:190-201`).
- **The boundary condition mirrors TAC's own.** `markerSent = spoken !== '' && !abortSignal.aborted && socket.readyState === OPEN` (`voice.ts:601-604`) reproduces the bundle's `!signal?.aborted && hasSentTokens && ws.readyState === OPEN`. The previous "non-empty return is enough" version was wrong: `sendStreamingResponse` does `fullResponse += chunk` before `ws.send` and both of its `break`s fall through to `return fullResponse`, so a barged-in turn returned a non-empty partial and recorded `ending: 'last-token'` for a marker TAC never sent (`voice.ts:574-599`).

## 9. Wrapping TAC from outside vs reaching inside

**Outside only — TAC gets no patch anywhere.** There is no TAC instrumentation, no monkey-patch, no wrapper module. What the repo does is (a) not register the voice channel, so TAC's forwarders never take the `setup`/`prompt`/`interrupt`/`webSocketDisconnected` slots, and the callbacks stay this repo's (`tac.ts:432-473`); and (b) put its own timestamp on the **first line** of each callback, before any await (`voice.ts:405`, `:953`). Everything in §3 is built out of those four callback entry instants plus `sendStreamingResponse`'s resolution.

**Reached inside — by reading the installed bundle, not by patching it.** Every one of these is a fact about `twilio-agent-connect@2.2.0`'s source that the span layout depends on:
- `sendStreamingResponse` writes each chunk with a **synchronous** `ws.send` inside its own `for await`, which is the entire justification for `turn.ttfa_ms` being a valid anchor (`voice.ts:350-356`).
- Its end-of-turn marker condition, mirrored above (`voice.ts:589-592`).
- `handleInterruptMessage` cancels the stream task and, if tokens had gone out, sends `{type:'text', token:'', last:true}` **itself** before invoking the callback (guard: `cancelled && wasStreaming`) — so on a barge-in the marker has already left the socket and the interrupt receipt is the only correct boundary (`voice.ts:915-920`).
- `handlePromptMessage` awaits `retrieveMemoryIfEnabled` before `onPrompt`, and serialises prompts per conversation through `promptQueues` — the two reasons `promptAt` is a floor, not the caller's stop (`voice.ts:394-403`).
- `sendStreamingResponse` resolves its abort signal as `options?.signal ?? activeTask?.controller.signal`, and `cancelStreamTask` aborts **and then deletes** the map entry — so passing our own `{signal}` is mandatory or barge-in doesn't work at all (`voice.ts:541-548`).
- `PromptMessageSchema` parses `lang` but `handlePromptMessage` spreads only five fields, so `lang` is dropped; wired anyway, and `asr.final` records the absence (`tac.ts:449-457`, `voice.ts:503`).
- `session.pendingHandoffData` is drained only by `sendResponse`, never by `sendStreamingResponse` — so a streaming app must send those five lines itself (`voice.ts:733-765`).

**Explicit non-goal:** TAC is never worked around. `memory-compose.ts:307-320` corrects an earlier claim that TAC "folds" memory into the prompt (`MemoryPromptBuilder` has zero callers in 2.2.0); `memoryMode` decides only whether and how often Recall is called.

## 10. What an outside reader gets from this repo's structure, not from TAC

- **`runTurn` is channel-agnostic with zero vendor imports** — not `ai`, not `twilio-agent-connect`, not `@langfuse/client` (`run-turn.ts:23-25`), statically enforced by `tests/architecture.test.ts` and proved at runtime by a Twilio-free bench. This is what makes one span tree serve voice, SMS and the bench, and what makes `turn.<channel>` a single `functionId` line.
- **Span operations are injected** (`TurnSpans` = `{timeStep, startStep}`, `agent/spans.ts:22`, `agent/types.ts:223-229`), so the span tree is assertable against a recording fake. Without that seam, verifying the tree means a real exporter.
- **The turn-span ownership contract** — caller creates and ends, `runTurn` only writes (`run-turn.ts:5-21`). An outside reader porting this to a framework agent object has to re-derive it.
- **Two bounded, swept registries.** `ConversationRegistry` (`conversations.ts`) exists because neither channel has a reliable end signal: the bench has none at all, and `onConversationEnded` fires only on CO's CLOSED, gated by `statusTimeouts` (`conversations.ts:13-19`). `VoiceTimeline` is capped at 50 with the registry's `onClose` as the normal reaper (`voice-timeline.ts:23-27`, `tac.ts:397`).
- **Which signal ends a voice trace, and it is the opposite of SMS.** `webSocketDisconnected`, not `conversationEnded`: in orchestrated mode every TAC `endConversation` path is gated on `!isOrchestratorEnabled()` except the CO `CLOSED` webhook, so a hangup fires no `conversationEnded` at all (`voice.ts:1004-1011`).
- **`conversations.end()` before `timeline.forget()`.** `end` runs `onClose`, which is where the call-level statistics are read onto the root — reversing it yields a root with `closedBecause` and nothing else. And the trailing `forget` is not redundant: `onClose` only fires if a registry entry exists, and a root already closed by the TTL sweep leaves a timeline entry alive (`voice.ts:1028-1039`).
- **`forget()` reads stats and cleans up in one call**, because it is `forget` that completes a turn still live at close time — the two-call version reported `turns.count: 0` on a call that dropped mid-turn while a `turn.voice` child sat in the same trace (`voice-timeline.ts:126-134`).
- **Nothing may be awaited between `runTurn` resolving and the drain.** The budget is one macrotask (`setImmediate`), measured: one `await Promise.resolve()` before the loop still wins, two lose, and so does any `await` that itself awaits. Losing is silent — `done` settles early, `llm.stream` ends before the stream drains, and `ttftMs`/`totalMs` report `null` while the caller hears the whole answer (`run-turn.ts:493-506`, enforced by comment at `voice.ts:532-539` and `messaging.ts:116-120`).
- **Span payloads are PII-scrubbed on the way in** by `scrubFields` (`spans.ts:43-44`) — added because a span `input` of `{from:'+1555…'}` reached Langfuse verbatim during T6. Honest limit stated in §5.
- **The read side.** Langfuse here is v4 in `events_only` mode, so `GET /api/public/traces` returns **404 meaning disabled, not empty**; verification goes through ClickHouse `events_core` / `events_full` or the UI (project `CLAUDE.md`, query at `docs/HANDOFF.md:1740-1749`).

## Citations

- file:///Users/dtolbert/code/tac-langfuse/server/obs/instrumentation.ts:1-87
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:5-15
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:30-44
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:65-90
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:108-133
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:136-148
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:153-178
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:180-249
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:251-298
- file:///Users/dtolbert/code/tac-langfuse/server/obs/spans.ts:331-348
- file:///Users/dtolbert/code/tac-langfuse/server/obs/voice-timeline.ts:18-27
- file:///Users/dtolbert/code/tac-langfuse/server/obs/voice-timeline.ts:35-137
- file:///Users/dtolbert/code/tac-langfuse/server/obs/voice-timeline.ts:163-181
- file:///Users/dtolbert/code/tac-langfuse/server/obs/voice-timeline.ts:195-295
- file:///Users/dtolbert/code/tac-langfuse/server/obs/voice-timeline.ts:297-388
- file:///Users/dtolbert/code/tac-langfuse/server/obs/first-token.ts:1-69
- file:///Users/dtolbert/code/tac-langfuse/server/obs/conversations.ts:7-28
- file:///Users/dtolbert/code/tac-langfuse/server/obs/conversations.ts:53-163
- file:///Users/dtolbert/code/tac-langfuse/server/agent/spans.ts:1-22
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:5-25
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:190
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:204-259
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:262-332
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:353-356
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:381-434
- file:///Users/dtolbert/code/tac-langfuse/server/agent/run-turn.ts:475-560
- file:///Users/dtolbert/code/tac-langfuse/server/agent/model/openai.ts:11-13
- file:///Users/dtolbert/code/tac-langfuse/server/agent/model/openai.ts:39-99
- file:///Users/dtolbert/code/tac-langfuse/server/agent/model/openai.ts:137-196
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:328-379
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:386-505
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:507-608
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:733-765
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:795-880
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:882-1002
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:1004-1049
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/messaging.ts:19-24
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/messaging.ts:90-149
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/tac.ts:303-362
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/tac.ts:364-474
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/memory-compose.ts:132-152
- file:///Users/dtolbert/code/tac-langfuse/server/index.ts:1-27
- file:///Users/dtolbert/code/tac-langfuse/server/index.ts:58-83
- file:///Users/dtolbert/code/tac-langfuse/node_modules/@langfuse/otel/dist/index.mjs:284-300
- file:///Users/dtolbert/code/tac-langfuse/node_modules/@langfuse/otel/dist/index.mjs:336-372
- file:///Users/dtolbert/code/tac-langfuse/node_modules/@langfuse/otel/dist/index.mjs:451-474
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md:370-415
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md:1740-1790
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md:1856-1880
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md:1927-1965
- file:///Users/dtolbert/code/tac-langfuse/.env.example:214-259
- file:///Users/dtolbert/code/tac-langfuse/scripts/verify-telemetry.ts:228
- file:///Users/dtolbert/code/tac-langfuse/scripts/verify-turn.ts:261-263

## Unverified

- The concrete OTel BatchSpanProcessor defaults that apply when LANGFUSE_FLUSH_AT / LANGFUSE_FLUSH_INTERVAL are unset (commonly 512 spans / 5000 ms / 2048 queue) — I confirmed the processor is constructed with both options `undefined` (@langfuse/otel/dist/index.mjs:369-372) but did not open @opentelemetry/sdk-trace-base to read the default constants.
- All quoted facts about twilio-agent-connect 2.2.0 internals (`sendStreamingResponse`'s synchronous ws.send, its marker condition, `handleInterruptMessage`'s `cancelled && wasStreaming` guard, `handlePromptMessage`'s memory await and promptQueues, `pendingHandoffData` having no drain on the streaming path) are quoted from this repo's own code comments, which cite reading the installed bundle. I did not re-open node_modules/twilio-agent-connect to re-verify them in this pass.
- The exact set of `gen_ai.*` attribute names the AI SDK/Langfuse integration emits — I took the four cited names from docs/HANDOFF.md's ClickHouse queries rather than from a live trace or from the integration source.
- Whether `functionId: 'turn.<channel>'` becomes the Langfuse observation/trace name or only an attribute — the repo asserts it is what separates voice from SMS, but I did not read the integration's mapping of `functionId`.
- The `turn.bench` / `conversation.bench` shape in section 4 is from docs/HANDOFF.md plus conversations.ts defaults; I did not read server/http/routes-bench.ts.
