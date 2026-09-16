# TAC 2.2.0 extension surface

# TAC 2.2.0 extension-point surface, as shipped

The decisive answer first: **`onMessageReady` is NOT the streaming path.** Streaming happens because `VoiceChannel.sendStreamingResponse()` is a **public method** that consumes an `AsyncIterable<string>` you supply and does one `ws.send` per chunk. `onMessageReady`'s `Promise<string|null|void>` return is only the *non-streaming auto-send* convenience: `TAC.handleMessageReady` checks `typeof response === "string"` and calls `channel.sendResponse(...)`, which sends a single frame with `last: true`. Return `null`/`void` and TAC sends nothing — you then push tokens yourself. There is no token sink passed into the callback and no writable; the seam is that you call back *into* the channel.

## 1. Registerable callbacks — exact signatures

### On `TAC` (single-slot setters; second registration silently replaces the first)

```ts
type MessageReadyCallback = (params: {
  conversationId: ConversationId;          // string & { readonly _brand: 'ConversationId' }
  profileId: ProfileId | undefined;
  message: string;
  author: string;
  memory: TACMemoryResponse | undefined;
  session: ConversationSession;
  channel: ChannelType;                    // 'sms'|'voice'|'chat'|'rcs'|'whatsapp'
  abortSignal?: AbortSignal;
}) => Promise<string | null | void> | string | null | void;

type InterruptCallback = (params: {
  conversationId: ConversationId;
  utteranceUntilInterrupt: string | undefined;
  durationUntilInterruptMs: number | undefined;
  session: ConversationSession;
}) => Promise<void> | void;

type ConversationEndedCallback = (params: { session: ConversationSession }) => Promise<void> | void;

tac.onMessageReady(cb): void;      // d.ts:3073
tac.onInterrupt(cb): void;         // d.ts:3077
tac.onConversationEnded(cb): void; // d.ts:3086
```
Types at `dist/index.d.ts:3017`, `:3027`, `:3033`. That is the whole `TAC`-level callback set — there are no others. Errors thrown out of any of them are caught and only logged (`dist/index.js:2924`, `:2836`, `:2854`).

### `BaseChannel.on(event, callback)` — `dist/index.js:3209`

Not an EventEmitter. It is a `switch` that assigns into one of three fields. `callback` is typed `(...args: any[]) => void`, so **nothing about the payload is typechecked** at a call site. The complete set of strings it accepts, grepped from the implementation:

| event string | slot | payload actually emitted | emit site |
|---|---|---|---|
| `'conversationStarted'` | `callbacks.onConversationStarted` | `{ session: ConversationSession }` | `index.js:3256` |
| `'conversationEnded'` | `callbacks.onConversationEnded` | `{ session }`, awaited, before the session is deleted | `index.js:3272` |
| `'error'` | `callbacks.onError` | `{ error: Error, context?: Record<string, unknown> }` — `context` key is **omitted entirely** when absent, not undefined | `index.js:3315`/`:3317` |

Anything else falls through the `switch` with no default and is **silently dropped**.

`MessagingChannel.on` override (`index.js:3582`) adds exactly one, then delegates to `super`:

| `'messageReceived'` | `{ conversationId, profileId: ProfileId\|undefined, message: string, author: string, userMemory: any }` | `index.js:3772` |

`VoiceChannel.on` override (`index.js:4846`) adds five, `default:` → `super.on`:

| event | payload | emit site |
|---|---|---|
| `'setup'` | `{ callSid: string; from: string; to: string; customParameters: Record<string,unknown>\|undefined }` | `index.js:5028` |
| `'prompt'` | `{ conversationId; transcript: string; abortSignal: AbortSignal; userMemory?: TACMemoryResponse; session?: ConversationSession }` — `userMemory`/`session` **conditionally spread**, keys absent when undefined; awaited | `index.js:5170` |
| `'interrupt'` | `{ conversationId; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }` — **not** awaited, no `session` | `index.js:5207` |
| `'webSocketConnected'` | `{ conversationId }` — fires from **two** places (direct connect `:4984`, orchestrated adoption `:5061`) | `index.js:4984`, `:5061` |
| `'webSocketDisconnected'` | `{ conversationId }` | `index.js:5224` |

Declared shapes: `BaseChannelEvents` `d.ts:2829`, `MessagingChannelEvents` `d.ts:3177`, `VoiceChannelEvents` `d.ts:3538`.

### The collision that will bite you

`TAC.registerChannel()` → `setupChannelEventListeners()` (`index.js:2781`) itself calls `channel.on(...)` for **`'error'`, `'messageReceived'`, `'prompt'`, `'interrupt'`, `'conversationEnded'`**. Because `on` is a setter, not an adder, registering a channel **clobbers** any listener you set on those five names, and setting one after `registerChannel` clobbers TAC's forwarder — which means `onMessageReady`/`onInterrupt`/`onConversationEnded` silently stop firing for that channel. `'setup'`, `'conversationStarted'`, `'webSocketConnected'`, `'webSocketDisconnected'` are never claimed by TAC and are always yours. This repo already relies on that: `server/twilio/tac.ts:432` deliberately does *not* register the voice channel so it can own `prompt`/`interrupt`.

### `VoiceChannel` webhook handler registrations (single-slot, distinct from `on`)

```ts
type InboundCallTwimlHandler = (req: TwiMLRequest) => Promise<TwiMLOptions>;              // d.ts:3528
type CallStatusHandler       = (event: CallStatusEvent) => Promise<void> | void;          // d.ts:3530
type AmdHandler              = (event: AmdEvent) => Promise<void> | void;                 // d.ts:3532
type RecordingHandler        = (event: RecordingEvent) => Promise<void> | void;           // d.ts:3534

voiceChannel.onInboundCallTwiml(cb): void;  // d.ts:3615
voiceChannel.onCallStatus(cb): void;        // d.ts:3640
voiceChannel.onAmd(cb): void;               // d.ts:3659
voiceChannel.onRecording(cb): void;         // d.ts:3677
```

Payload fields (all `z.ZodOptional<z.ZodString>` unless noted, plus `extra: Record<string,string>` for unrecognized form keys):
- `TwiMLRequest` (`d.ts:1819`): `from, to, callSid, callerCountry, callerState, callerCity, direction, extra`.
- `CallStatusEvent` (`d.ts:1885`): `callSid: string` (required), `callStatus, callDuration, sipResponseCode, accountSid, extra`, plus computed `isUnreached: boolean`.
- `AmdEvent` (`d.ts:1925`): `callSid: string`, `answeredBy, machineDetectionDuration, accountSid, extra`, plus computed `isMachine: boolean`.
- `RecordingEvent` (`d.ts:1959`): `callSid: string`, `recordingSid, recordingUrl, recordingStatus, recordingDuration, accountSid, extra`.

Registration is load-bearing, not just observational: with no handler registered TAC **omits** the corresponding `statusCallback` / `asyncAmdStatusCallback` / `recordingStatusCallback` parameter from `calls.create`, so Twilio has nowhere to post.

## 2. Tool surface — no hooks, you must decorate each tool

```ts
type ToolFunction<TParams = unknown, TResult = unknown> = (params: TParams) => Promise<TResult> | TResult;  // d.ts:2170

class TACTool<TParams, TResult> {                                    // d.ts:4300
  readonly name: string; readonly description: string;
  readonly parameters: JSONSchema; readonly implementation: ToolFunction<TParams, TResult>;
  constructor(name, description, parameters, implementation);
  toOpenAIFormat(): OpenAITool; toAnthropicFormat(): AnthropicTool;
  toJSON(): string; toOpenAIAgentsSDKTool(): Promise<any>;
}
function defineTool<TParams, TResult>(name: string, description: string,
  parameters: JSONSchema, implementation: ToolFunction<TParams, TResult>): TACTool<TParams, TResult>;  // d.ts:4340
```

**TAC never invokes a tool.** `.implementation` is read at exactly two places in the whole bundle: assignment in the constructor (`index.js:6185`) and inside `toOpenAIAgentsSDKTool`'s `execute` (`index.js:6246`, `const impl = this.implementation` → `JSON.stringify(await impl(args))`). `toOpenAIFormat`/`toAnthropicFormat` emit *schema only* — the model runtime dispatches, TAC is not in the loop. There is no `onToolCall`, no middleware, no `ToolContext` plumbing (the exported `ToolContext` type at `d.ts:2221` is never consumed). So: **wrap each `TACTool`** (build a new `TACTool` around `tool.implementation`) or instrument at your model runtime. Note `toOpenAIAgentsSDKTool` sets `strict: false` and forces `additionalProperties: true` (`index.js:6247-6256`).

The factory helpers all return `TACTool`, so all are wrappable: `createMemoryRetrievalTool`, `createMemoryTools`, `createSendMessageTool`, `createMessagingTools`, `createStudioHandoffTool`, `createKnowledgeSearchTool`, `createKnowledgeSearchToolAsync`, `createKnowledgeTools`.

## 3. The streaming path, symbol by symbol

`TACServer` websocket route (`index.js:6828-6863`) validates the Twilio signature then calls the **public** `this.voiceChannel.handleWebSocketConnection(socket)` (`d.ts:3728`, impl `index.js:4991`). Inside, `ws.on('message')` parses with `WebSocketMessageSchema` (a union of `SetupMessageSchema | PromptMessageSchema | InterruptMessageSchema`, `index.js:772`) and switches on `type`:

- `'prompt'` is **serialized through `this.promptQueues`** (`index.js:5092-5099`): `previousPrompt.then(() => this.handlePromptMessage(...))`, so turn N+1 cannot start until turn N's handler resolves. This is a `Map<ConversationId, Promise<void>>`, `private readonly`.
- `handlePromptMessage` (`index.js:5163`) calls `startStreamTask(conversationId)` — which **aborts any prior task** (`index.js:5800`) — then `await this.voiceCallbacks.onPrompt({ conversationId, transcript, abortSignal: streamTask.controller.signal, ...userMemory, ...session })`.
- Your handler then calls **`sendStreamingResponse(conversationId, stream, options?)`** (`d.ts:3758`, impl `index.js:5277`). The mechanism, verbatim:

```js
for await (const chunk of stream) {
  if (signal?.aborted) break;
  if (ws.readyState !== WebSocket.OPEN) { ...break; }
  fullResponse += chunk;
  const tokenMessage = { type: "text", token: chunk, last: false };
  ws.send(JSON.stringify(tokenMessage));            // index.js:5308
  hasSentTokens = true;
  if (activeTask) activeTask.hasSentTokens = true;
}
if (!signal?.aborted && hasSentTokens && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ type: "text", token: "", last: true }));  // index.js:5315
}
```
It returns the accumulated `fullResponse: Promise<string>`. `signal` resolves as `options?.signal ?? activeTask?.controller.signal` (`index.js:5285`). `finally` calls `completeStreamTask` only if the task is still the current one (`index.js:5323`). On barge-in, `handleInterruptMessage` (`index.js:5182`) aborts the task and — only if `hasSentTokens` — sends the `last: true` finalizer *itself* (`index.js:5197`), which is why the streaming loop skips it when aborted.

**Yes, an external HTTP/SSE agent runtime can feed this path**, and cleanly, because the only contract is `AsyncIterable<string>`. The seam:

1. `voiceChannel.on('prompt', async (data) => { ... })` — do **not** `tac.registerChannel(voiceChannel)`, or TAC takes the slot.
2. In the handler, POST `data.transcript` (+ `data.conversationId`, `data.session?.profileId`, `data.userMemory`) to your remote runtime, opening an SSE/chunked response.
3. Wrap the SSE reader in an `async function*` that yields text deltas, and forward `data.abortSignal` to the `fetch` as `{ signal }` so barge-in cancels the upstream request as well as the local loop.
4. `await voiceChannel.sendStreamingResponse(data.conversationId, gen, { signal: data.abortSignal })`. Await it — the promptQueue uses your handler's promise as the turn boundary, and `sendStreamingResponse` rejects rather than throwing synchronously.

Two hard constraints on that design: `handleWebSocketConnection` requires a live local `ws` in the `private webSocketConnections` map, so the *transport* must terminate in this process (only the *brain* can be remote); and sessions are instance-local `Map`s with no shared store, so the remote runtime cannot be the source of session truth.

## 4. Logger

```ts
type Logger = pino.Logger;                                            // d.ts:2544
function createLogger(options?: { level?: string; name?: string }): Logger;   // d.ts:2545
```
`createLogger` (`index.js:1673`) is `pino({ level, name?, hooks: { logMethod: piiLogMethod } })`. `level` defaults to `process.env.TWILIO_LOG_LEVEL || 'info'`. **`createLogger` exposes no destination/transport/stream argument** — there is no sink parameter.

The pluggable sink is one level up: `TACOptions.logger?: Logger` (`d.ts:3012`), and `TAC.create` does `const finalLogger = options.logger ?? createLogger({ name: 'tac' })` (`index.js:2717`). Pass your own pino instance built over `pino.multistream` / a custom `Writable` / `pino.transport` and an OTEL log bridge attaches there. Every channel derives from it: `this.logger = tac.logger.child({ component: 'channel' })` (`index.js:3185`), so a custom root logger reaches all channel logging. Caveat: supplying your own logger **drops `piiLogMethod`** unless you re-add `hooks: { logMethod }` yourself — `scrubPii`/`scrubObject`/`maskPhone`/`maskEmail`/`maskAddress`/`redactTwimlParameters` are all exported so you can. Also note `BaseClient` and `OperatorResultProcessor` fall back to their *own* `createLogger` when constructed without one (`index.js:1694`, `:2473`), and `TACServer` builds Fastify's logger independently from `TWILIO_LOG_LEVEL` (`index.js:6637`) — plus one raw `console.warn` at `index.js:6630`.

## 5. Private / unreachable — needs a prototype or instance patch to observe

`VoiceChannel` `private readonly` state (`d.ts:3579-3587`): **`webSocketConnections`**, **`voiceCallbacks`**, **`streamTasks`**, **`promptQueues`**, `initializationRetries`, `callSidToConversationId`, `MAX_INITIALIZATION_RETRIES`, `twilioClient`, `voiceConfig`, and the four handler slots `onInboundCallTwimlHandler`/`onCallStatusHandler`/`onAmdHandler`/`onRecordingHandler`.

`private` methods, i.e. no interception point without patching `VoiceChannel.prototype`: **`handlePromptMessage`** (`d.ts:3732` — the only place per-turn start is observable), **`handleInterruptMessage`** (`:3736`), **`handleWebSocketDisconnect`** (`:3742`), `handleConversationUpdated` (`:3713`), `initializeOrchestratedConversation` (`:3724`), `resolveWebsocketUrl`, `resolveDefaultActionUrl`, `getTwilioClient`, `buildTwimlOptions`, `overlayFields`, `resolveActionUrl`, `mergeCallOptions`, `buildCallParams`, `callEventAccountOk`, `dispatchCallEvent`, `generateTwiml`, `filterUnsetValues`, `RELAY_ATTR_FIELDS`.

On `TAC`: **`handleMessageReady`** (`d.ts:3068`), **`setupChannelEventListeners`** (`:3064`), the three callback slots, `memoryClient`/`knowledgeClient`/`conversationClient`/`memoryStoreId`, `FACTORY_TOKEN`, and the `private constructor` — so `TAC` cannot be subclassed usefully; `TAC.create()` is the only door.

On `TACServer`: `setupRoutes` (`d.ts:4638`), `validateRequestSignature`, `getWebhookUrl`, `getForwardedProto`/`getForwardedHost`, `waitForWebSocketsToClose`, `validateCallEventPaths`, and the channel lists. `readonly fastify` **is** public, so you can add routes and Fastify hooks alongside TAC's.

`BaseChannel` `protected` (reachable by subclassing, not from outside): `activeConversations`, `callbacks`, `startConversation`, `endConversation`, `handleError`, `retrieveMemoryIfEnabled`, `invalidateCachedMemory`, `preprocessWebhook`, `isDuplicateWebhook`, `extractConversationId`, `extractProfileId`. `private`: `processedWebhookTokens`, `maxTrackedTokens`.

Two things that look private but are not, and are the highest-leverage observation points:
- **`getWebsocket(conversationId): WebSocket | null`** (`d.ts:3717`, impl `index.js:4934`) hands you the live socket. Patching `ws.send` on that instance is a supported-looking way to see every outbound frame including the `last: true` finalizer, without touching TAC's prototype.
- **`startStreamTask` / `cancelStreamTask` / `completeStreamTask` / `hasActiveStreamTask`** are all public (`d.ts:4032-4052`), so turn-boundary bookkeeping is observable and drivable.

Unhandled inbound: only `setup`, `prompt`, `interrupt` are dispatched. Any other ConversationRelay message type hits `default:` and is `logger.debug`-ed as `"Unhandled WebSocket event type"` (`index.js:5109`); a message that fails `WebSocketMessageSchema` is debug-logged and dropped (`index.js:5003`). DTMF is not surfaced at all. `PromptMessageSchema` parses `lang` and `agentSpeaking` (`index.js:760`) but `handlePromptMessage` never forwards them.

## 6. Pre-existing telemetry — effectively none

Confirmed: `grep -rn "opentelemetry|OTEL|otel" dist/` returns **zero matches**. No metrics, no tracer, no span, no histogram. There is no `EventEmitter` anywhere in the public surface either.

Total timing data TAC surfaces, exhaustively — three items, none of them a duration TAC measured of itself:
1. `durationUntilInterruptMs` on the interrupt payload — parsed straight out of ConversationRelay's `interrupt` frame (`InterruptMessageSchema`, `index.js:767`), i.e. Twilio's number, not TAC's.
2. `query_time_ms: response.meta?.queryTime` in one `logger.debug` on memory retrieval (`index.js:1854`) — Twilio's server-side Recall time.
3. `callDuration` (`CallStatusEvent`), `machineDetectionDuration` (`AmdEvent`), `recordingDuration` (`RecordingEvent`), `SessionDuration` (`ConversationRelayCallbackPayload`) — all Twilio-reported strings off webhook forms.

The only `Date.now()` calls in the bundle are a synthetic message id (`index.js:6386`) and the shutdown websocket-drain deadline (`index.js:6979`). `performance.now()` and `process.hrtime` do not appear. Everything else is pino logs at `info`/`debug` with `conversation_id` / `call_sid` / `profile_id` fields — which is why the custom-logger seam in §4 is the only zero-patch route to structured observability, and why per-turn latency has to be measured by the caller around `on('prompt')` and `sendStreamingResponse`.

## Citations

- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3017
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3027
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3033
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3073
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3077
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3086
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2829
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2889
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3177
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3538
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3528
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3530
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3532
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3534
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3615
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3640
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3659
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3677
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3717
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3728
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3746
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3758
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4032
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4039
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4045
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4052
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2170
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2221
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4300
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4340
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2544
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:2545
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3012
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3579
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3732
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3736
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:3742
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:1819
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:1885
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:1925
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:1959
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:1196
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts:4596
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2781
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2717
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2865
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2900
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2830
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:2851
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3209
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3256
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3272
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3315
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3185
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3582
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:3772
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:4846
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:4934
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:4991
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5003
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5028
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5092
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5109
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5163
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5170
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5182
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5197
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5207
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5224
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5240
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5277
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5308
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5315
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5323
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:5800
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6180
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6246
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6265
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:1673
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:1667
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:1694
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:1854
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6630
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6637
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6828
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6862
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:6979
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:760
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:767
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.js:772
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/package.json:1
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/tac.ts:339
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/tac.ts:432
- file:///Users/dtolbert/code/tac-langfuse/server/twilio/voice.ts:279

## Unverified

- Whether an external HTTP/SSE runtime feeding `sendStreamingResponse` actually works end to end — the integration seam is derived from reading the shipped code, not exercised. In particular the abort propagation (forwarding `data.abortSignal` into a remote `fetch`) and the promptQueue turn-boundary behaviour under a remote round trip were not run.
- Whether ConversationRelay ever sends message types other than `setup`/`prompt`/`interrupt` on this account's configuration (e.g. a DTMF or error frame). The bundle's `default:` branch proves TAC would drop them, but I did not observe live traffic to confirm any are sent.
- `agentSpeaking` and `lang` are parsed by `PromptMessageSchema` and dropped by `handlePromptMessage`; I confirmed the drop from the code but did not confirm Twilio actually populates them on a live call.
- That supplying a custom `TACOptions.logger` reaches every logging site — `BaseClient` and `OperatorResultProcessor` fall back to `createLogger` when constructed without an explicit logger, and I did not trace every construction site to confirm TAC always passes its own logger down to them.
- Behaviour of `toOpenAIAgentsSDKTool()` — `@openai/agents` is an optional peer dep and is not installed here, so the dynamic-import path was read, not executed.
- The exact effect of registering a channel with TAC *after* setting your own `prompt` listener versus before. The clobbering is a direct consequence of `on` being a setter and `setupChannelEventListeners` calling `on`, but I did not run both orderings to observe the silent failure.
