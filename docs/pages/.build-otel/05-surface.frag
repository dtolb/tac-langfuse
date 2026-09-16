  <!-- ============ 01 THE INJECTION SURFACE ============ -->
  <section id="surface">
    <h2><span class="num">01</span> <b>The injection surface</b> &middot; the seam is not a callback</h2>

    <p class="lede-sm">The three numbers the library reports of its own accord are
    <code>durationUntilInterruptMs</code> parsed out of the ConversationRelay interrupt frame, a memory
    query time echoed from the platform in one debug log, and the call, machine-detection and recording
    durations that arrive as strings on webhook forms. None of them is a duration the library measured of
    itself. This section is about where the outside of the library actually is.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The correction to make first</p>
      <p>The obvious reading is that <code>onMessageReady</code> is the response path, so a turn span
      should open when that callback fires and close when it returns. That reading is wrong for voice, and
      it is the single most expensive misconception to hold while designing spans.</p>
      <p><code>onMessageReady</code> returns <code>Promise&lt;string | null | void&gt;</code>. The
      dispatcher checks <code>typeof response === "string"</code> and, if so, calls
      <code>channel.sendResponse(...)</code>, which writes one frame carrying <code>last: true</code>.
      That is a non-streaming convenience. Return <code>null</code> or <code>void</code> and the library
      sends nothing at all. There is no token sink in the callback parameters and no writable to hand
      tokens to.</p>
      <p>Streaming happens because <code>VoiceChannel.sendStreamingResponse</code> is public. The
      signature below was read from the shipped type declarations of
      <code>twilio-agent-connect@2.2.0</code>.</p>
    </div>

    <pre class="wide">sendStreamingResponse(
  conversationId: ConversationId,
  stream: AsyncIterable&lt;string&gt;,
  options?: { signal?: AbortSignal },
): Promise&lt;string&gt;;</pre>

    <p class="lede-sm">You supply the <code>AsyncIterable&lt;string&gt;</code>. Inside, the library
    iterates it and performs one synchronous <code>ws.send</code> per chunk, writes the
    <code>{ type: "text", token: "", last: true }</code> marker after the loop only if at least one token
    went out and the signal did not fire, and resolves with the accumulated text.</p>

    <p class="lede-sm">Three consequences follow for anyone instrumenting a turn. The turn boundary you
    want is the instant the prompt payload reaches your handler paired with the instant that
    <code>last: true</code> marker leaves the socket, and both instants are yours to stamp, because you
    own the first line of the handler and you own the iterable. Because the per-chunk send is synchronous
    inside the library's own <code>for await</code>, the moment your generator yields its first non-empty
    text delta is within microseconds of the moment the frame hits the socket, which is what makes a
    server-side first-audio proxy meaningful at all. And the streaming path is voice-only by
    construction: the messaging and chat path is <code>MessageReadyCallback</code>, whose parameters carry
    <code>memory</code> rather than the voice payload's <code>userMemory</code> and whose
    <code>abortSignal</code> is optional where the voice payload's is required. There is no streaming sink
    for SMS or chat, so token-level attributes on those channels are not available at any price.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Every
    extension point 2.2.0 exposes</h3>

    <p class="lede-sm">Signatures below were read from the shipped 2.2.0 type declarations and
    implementation bundle. <code>BaseChannel.on</code> is not an EventEmitter: it is a
    <code>switch</code> that assigns into one of a fixed set of single slots, its callback is typed
    <code>(...args: any[]) =&gt; void</code> so nothing about the payload is typechecked at your call site,
    and an unrecognised event string falls through with no default and is silently dropped. Registering a
    channel with the top-level object calls <code>on</code> for <code>error</code>,
    <code>messageReceived</code>, <code>prompt</code>, <code>interrupt</code> and
    <code>conversationEnded</code>, so those five slots are taken from you if you register, and taking
    them back afterwards silently stops the top-level callbacks firing for that channel. The four slots
    the library never claims are <code>setup</code>, <code>conversationStarted</code>,
    <code>webSocketConnected</code> and <code>webSocketDisconnected</code>.</p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:900px">
        <thead>
          <tr><th>Extension point</th><th>Signature or payload</th><th>Span or attribute it can produce</th><th>What it structurally cannot see</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>voiceChannel.on('setup')</code></td>
            <td><code>{ callSid, from, to, customParameters }</code></td>
            <td>Trace-level correlation keys, including a call identifier suitable for
            <code>gen_ai.conversation.id</code>. The earliest point a conversation root could open.</td>
            <td>Nothing about turns. It fires before any prompt and cannot tell you whether a conversation
            record exists yet.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.on('webSocketConnected')</code></td>
            <td><code>{ conversationId }</code>, fired from two distinct sites, direct connect and
            orchestrated adoption</td>
            <td>The open boundary of a call-level span.</td>
            <td>Which of the two sites fired it, without inspecting state yourself.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.on('webSocketDisconnected')</code></td>
            <td><code>{ conversationId }</code></td>
            <td>The close boundary of a call-level span, and on voice this is the signal that actually
            arrives: in orchestrated operation a hangup fires no <code>conversationEnded</code> at all.</td>
            <td>Why the socket closed. Caller hangup, transport failure and shutdown are
            indistinguishable here.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.on('prompt')</code></td>
            <td><code>{ conversationId, transcript, abortSignal, userMemory?, session? }</code>, awaited by
            the library</td>
            <td>Turn span start, a zero-duration transcript event, and the closing edge of a back-dated
            caller-side span.</td>
            <td>Speech-to-text arrival, frame parse, stream-task setup and the platform memory recall, all
            of which happen before your first line runs. Also <code>lang</code> and
            <code>agentSpeaking</code>, which the inbound schema parses and the handler then does not
            forward in 2.2.0.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.sendStreamingResponse(...)</code></td>
            <td><code>(ConversationId, AsyncIterable&lt;string&gt;, options?) =&gt; Promise&lt;string&gt;</code></td>
            <td>A bot-output span anchored at the first non-empty delta and closed at the end-of-turn
            marker, plus a server-side time-to-first-audio proxy.</td>
            <td>Speech synthesis and playback. ConversationRelay exposes neither over the socket, so the
            audible half of the turn is invisible from this process.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.on('interrupt')</code></td>
            <td><code>{ conversationId, utteranceUntilInterrupt?, durationUntilInterruptMs? }</code>, not
            awaited, and with no <code>session</code></td>
            <td>A barge-in event and the correct turn boundary on an interrupted turn.</td>
            <td>Any ambient trace context. The library dispatches this from its own socket handler, so a
            span started here with no explicit parent becomes the root of a second trace.</td>
          </tr>
          <tr>
            <td><code>tac.onMessageReady(cb)</code></td>
            <td>Returns <code>Promise&lt;string | null | void&gt; | string | null | void</code>; params
            carry <code>memory</code>, <code>session</code>, <code>channel</code> and an optional
            <code>abortSignal</code></td>
            <td>The entire messaging or chat turn span, opened on entry and closed when your promise
            settles.</td>
            <td>Any token-level timing. There is no streaming sink on this path, so first-token latency on
            SMS and chat is not measurable.</td>
          </tr>
          <tr>
            <td><code>messagingChannel.on('messageReceived')</code></td>
            <td><code>{ conversationId, profileId, message, author, userMemory }</code></td>
            <td>An inbound-message event.</td>
            <td>Nothing, if you registered the channel: this is one of the five slots registration
            takes.</td>
          </tr>
          <tr>
            <td><code>tac.onInterrupt(cb)</code></td>
            <td>Same payload as the channel-level interrupt, plus <code>session</code></td>
            <td>Same as the channel-level interrupt.</td>
            <td>The same blindness to ambient context.</td>
          </tr>
          <tr>
            <td><code>tac.onConversationEnded(cb)</code></td>
            <td><code>{ session: ConversationSession }</code></td>
            <td>The close boundary of a messaging conversation span.</td>
            <td>The voice hangup, for the orchestrated reason above.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.onInboundCallTwiml(cb)</code></td>
            <td><code>(req: TwiMLRequest) =&gt; Promise&lt;TwiMLOptions&gt;</code></td>
            <td>Nothing timed, but this is where you inject per-call transport facts.</td>
            <td>Anything after the call connects.</td>
          </tr>
          <tr>
            <td><code>onCallStatus</code>, <code>onAmd</code>, <code>onRecording</code></td>
            <td><code>(event) =&gt; Promise&lt;void&gt; | void</code> for each event type</td>
            <td>Platform-reported durations as attributes on a call-level span.</td>
            <td>Anything sub-turn. Registration is load-bearing rather than observational: with no handler
            registered the library omits the matching status callback parameter when it creates a call, so
            the platform has nowhere to post.</td>
          </tr>
          <tr>
            <td><code>TACOptions.logger</code></td>
            <td><code>type Logger = pino.Logger</code>, consumed as
            <code>options.logger ?? createLogger({ name: 'tac' })</code></td>
            <td>A log bridge. Every channel derives from it by <code>.child(...)</code>, so one root
            logger reaches channel logging.</td>
            <td>This is the only zero-patch route to structured output and it is undocumented upstream.
            Supplying your own instance drops the library's own scrubbing log hook unless you reinstall
            it; the scrubbing helpers are exported so that you can.</td>
          </tr>
          <tr>
            <td><code>TACTool</code> and <code>defineTool</code></td>
            <td><code>defineTool&lt;TParams,TResult&gt;(name, description, parameters, implementation)</code></td>
            <td>Tool spans, but only if you build them.</td>
            <td>There is no <code>onToolCall</code>, no middleware and no tool context plumbing. The
            exported <code>ToolContext</code> type has no consumer in the bundle. The library never
            invokes a tool, so instrument by wrapping each tool or at your model runtime.</td>
          </tr>
          <tr>
            <td><code>voiceChannel.getWebsocket(id)</code></td>
            <td>Returns the live socket or <code>null</code></td>
            <td>Every outbound frame, including the end-of-turn marker, if you wrap <code>send</code> on
            that instance.</td>
            <td>It looks private and is not. Wrapping an instance method is still a patch, just not a
            patch on the library's prototype.</td>
          </tr>
          <tr>
            <td><code>startStreamTask</code>, <code>cancelStreamTask</code>,
            <code>completeStreamTask</code>, <code>hasActiveStreamTask</code></td>
            <td>All public on <code>VoiceChannel</code></td>
            <td>Turn-boundary bookkeeping, observable and drivable.</td>
            <td>The queue that serialises prompts, which is separate state.</td>
          </tr>
          <tr>
            <td><code>handlePromptMessage</code></td>
            <td>Private. Prototype patch only.</td>
            <td>The only place per-turn start is observable strictly upstream of your handler, including
            the memory recall your handler waits behind.</td>
            <td></td>
          </tr>
          <tr>
            <td><code>handleInterruptMessage</code>, <code>handleWebSocketDisconnect</code></td>
            <td>Private. Prototype patch only.</td>
            <td>The instant the stream task is cancelled, before your callback runs, and socket teardown
            ordering.</td>
            <td></td>
          </tr>
          <tr>
            <td><code>handleMessageReady</code>, <code>setupChannelEventListeners</code></td>
            <td>Private. Prototype patch only.</td>
            <td>The dispatch decision that turns your returned string into a single frame.</td>
            <td>The constructor is private, so the class cannot be usefully subclassed. The static factory
            is the only door.</td>
          </tr>
          <tr>
            <td><code>promptQueues</code>, <code>streamTasks</code>, <code>webSocketConnections</code>,
            <code>voiceCallbacks</code></td>
            <td><code>private readonly</code> fields on <code>VoiceChannel</code></td>
            <td>Head-of-line queue depth and per-turn task identity.</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Two properties of private state that change how you read your own traces</p>
      <p>Prompt frames are chained. Turn N plus one is dispatched as
      <code>previousPrompt.then(() =&gt; this.handlePromptMessage(...))</code>, so it cannot start until
      turn N's handler resolves, which makes your prompt-receipt timestamp a floor rather than the
      caller's stop.</p>
      <p>The memory recall is awaited before your handler is called. On a voice configuration that recalls
      once per conversation, a platform round trip therefore lands in whatever span covers the interval
      before turn one, never inside turn one.</p>
    </div>
    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The span
    model, and where the specification runs out</h3>

    <p class="lede-sm">Nothing in the trees below is specification-named except the subtree the model SDK
    creates, and that is not an oversight. The GenAI conventions moved out of the main semantic-conventions
    repository into
    <a href="https://github.com/open-telemetry/semantic-conventions-genai">semantic-conventions-genai</a>,
    whose manifest reads <code>schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev</code>
    and <code>stability: development</code>. There is no tagged release, so there is no citable stable
    version, only a commit or that development schema URL. Every <code>gen_ai.*</code> attribute, span,
    metric, event and enum value in its tables is badged Development. The only Stable attributes on a
    GenAI span are borrowed from core conventions: <code>error.type</code>, <code>server.address</code>
    and <code>server.port</code>.</p>

    <p class="lede-sm">For voice specifically there is no merged convention for speech to text, text to
    speech, audio latency, barge-in or realtime sessions. The entire merged voice surface is audio token
    usage and <code>speech</code> as a well-known value of <code>gen_ai.output.type</code>. Two open pull
    requests propose the rest.
    <a href="https://github.com/open-telemetry/semantic-conventions-genai/pull/390">PR 390</a> proposes
    <code>speech_to_text</code> and <code>text_to_speech</code> operations plus
    <code>gen_ai.agent.invocation.end_reason</code>, which is the standard-track name for the barge-in
    outcome. <a href="https://github.com/open-telemetry/semantic-conventions-genai/pull/394">PR 394</a>
    argues that a live session streams user audio continuously while the server streams incremental
    output, so a generation cannot be represented by the client-timed inference span, and proposes a
    <code>generate_live_content</code> span anchored at first output, an opt-in
    <code>gen_ai.user_input.client</code> span bounded by voice-activity events, and a long-lived session
    modelled as events correlated by <code>gen_ai.conversation.id</code> rather than wrapped in a span.
    Neither is merged. Read the voice span names below as one working shape that happens to converge with
    an unmerged proposal, not as conformance.</p>

    <p class="lede-sm">For multi-turn grouping the specification offers exactly one mechanism, the
    attribute <code>gen_ai.conversation.id</code>. There is no conversation span, no cross-turn
    parent-child convention, and no use of the general <code>session.id</code> attribute. A call-level root
    span is therefore an extension, and a reader who wants only specification-blessed grouping should
    stamp the call identifier on every turn's spans and stop there.</p>

    <pre class="wide">conversation.voice                    <i>call-level root, extension, no spec equivalent</i>
│  input: { conversationId }
│  closed with: closedBecause, turns.count, turns.aborted,
│               caller.turn_total_ms, turn.ttfa_p50_ms, turn.ttfa_max_ms
│
├─ <b>caller.turn</b>                        <i>parented to the ROOT, not to the turn</i>
│    back-dated to the previous bot-output boundary, ended at prompt receipt
│    metadata: durationMs, and a "covers" string naming the blend
│
└─ <b>turn.voice</b>                         <i>opened at prompt receipt, closed at the output boundary</i>
     input.userText, metadata.channel
     metadata: prompt.name, prompt.version, prompt.label, model,
               tools.offered, tools.unknown
     metadata: turn.ttft_ms, turn.ttft_model_ms      <i>written at first non-empty delta</i>
     output: { text, toolCalls }
     metadata: tools.called, turn.total_ms, turn.total_model_ms, turn.aborted
     metadata: turn.ttfa_ms, turn.ending             <i>written last, at the boundary</i>
     level: ERROR plus statusMessage on a throw, which the wrapper must set itself
     │
     ├─ asr.final          <i>zero-duration event at prompt receipt: transcriptChars, lang</i>
     ├─ prompt.fetch       output { name, version, label }, metadata.durationMs
     ├─ memory.recall      output { chars }, metadata.durationMs, metadata.profileMs
     ├─ prompt.compose     output { systemChars, messages, historyMessages }
     ├─ tools.resolve      output { resolved[], unknown[], unavailable[] }
     ├─ llm.stream         <u>a TIMER, not a parent. See below</u>
     ├─ invoke_agent {model}     <i>created by the model SDK, parented to turn.voice</i>
     │    └─ chat {model}        <i>one per provider call</i>
     │         └─ execute_tool {name}
     ├─ tts.interrupted    <i>event at interrupt receipt, barge-in only:</i>
     │                     durationUntilInterruptMs, utteranceUntilInterrupt
     └─ tts.send           <i>back-dated child, first delta to boundary:</i>
                           durationMs, ending</pre>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">A naming note that will cost you an afternoon backwards</p>
      <p><code>prompt.fetch</code> and <code>memory.recall</code> do not measure the platform's own
      recall. The platform recall was already awaited upstream of your handler.
      <code>memory.recall</code> here measures composing the memory block out of the payload you were
      handed, plus a profile lookup that is a real network call when uncached. Those two steps genuinely
      run concurrently because they are your work, in your handler, behind one <code>Promise.all</code>.
      Anyone reading a waterfall and concluding the platform recall is concurrent with the prompt fetch
      has mislabelled the platform's serial recall, which sits in the preceding interval.</p>
      <p>Where the specification does have something to say, use it. <code>gen_ai.prompt.name</code> and
      <code>gen_ai.prompt.version</code> are real attributes, Conditionally Required when a named prompt
      template is used, so a versioned-prompt story maps onto the specification directly rather than
      needing a private key.</p>
    </div>

    <pre class="wide">conversation.sms
└─ <b>turn.sms</b>                      <i>opened on callback entry, closed when the promise settles</i>
     the same interior steps: prompt.fetch, memory.recall, prompt.compose,
     tools.resolve, llm.stream, and the invoke_agent subtree</pre>

    <p class="lede-sm">Absent by construction rather than by omission on the messaging tree: no
    <code>asr.final</code>, no caller-side span, no text-to-speech spans, no time to first audio and no
    turn-ending classification, because none of those signals exists on a path whose only output is one
    finished string. A first-token attribute on a messaging turn would be a fabrication.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">What the model
    SDK gives you free, and what the wrapper must set</h3>

    <p class="lede-sm">This split is the spine of the work. The AI SDK's OpenTelemetry integration emits
    GenAI-convention spans, and the free column below is from its own
    <a href="https://ai-sdk.dev/docs/ai-sdk-core/telemetry">telemetry documentation</a> as shipped with the
    installed version. Anything keyed on the older <code>ai.*</code> span names finds nothing.</p>

    <div class="wide tablewrap">
      <table style="min-width:820px">
        <thead>
          <tr><th>Span or attribute</th><th>Who sets it</th><th>Notes and caveats</th></tr>
        </thead>
        <tbody>
          <tr><td><code>invoke_agent {modelId}</code>, kind INTERNAL</td><td>free</td><td>Covers the whole
          operation including every step and tool call.</td></tr>
          <tr><td><code>chat {modelId}</code>, kind CLIENT, one per provider call</td><td>free</td><td>Nested
          under <code>invoke_agent</code>.</td></tr>
          <tr><td><code>execute_tool {toolName}</code>, kind INTERNAL</td><td>free</td><td>Nested under the
          step span, and only for tools the model runtime executes. A tool the Agent Connect layer hands
          you is a schema, and the library never invokes it.</td></tr>
          <tr><td><code>gen_ai.operation.name</code>, <code>gen_ai.provider.name</code>,
          <code>gen_ai.request.model</code></td><td>free</td><td>The first two are the only Required
          attributes on an inference span.</td></tr>
          <tr><td><code>gen_ai.agent.name</code></td><td>free, from the <code>functionId</code> you
          pass</td><td>This is the one place your channel label reaches a specification attribute, so set
          <code>functionId</code> per channel.</td></tr>
          <tr><td><code>gen_ai.request.temperature</code>, <code>max_tokens</code>, <code>top_p</code>,
          <code>top_k</code>, <code>frequency_penalty</code>, <code>presence_penalty</code>,
          <code>stop_sequences</code>, <code>seed</code></td><td>free when you send them</td><td>If you
          pass no provider options these arrive empty, and an empty request-parameter set is a finding
          rather than a bug.</td></tr>
          <tr><td><code>gen_ai.response.finish_reasons</code>, <code>gen_ai.response.id</code>,
          <code>gen_ai.response.model</code></td><td>free</td><td></td></tr>
          <tr><td><code>gen_ai.usage.input_tokens</code>, <code>output_tokens</code>,
          <code>cache_read.input_tokens</code>, <code>cache_creation.input_tokens</code></td><td>free</td>
          <td>The cache attributes are what let you separate a cold first turn from warm follow-ons.</td></tr>
          <tr><td><code>gen_ai.client.operation.duration</code>, in seconds</td><td>free</td><td></td></tr>
          <tr><td><code>gen_ai.client.operation.time_to_first_chunk</code>, in seconds</td><td>free</td>
          <td><b class="warn">Right name, right unit, wrong signal.</b> The specification defines that
          exact string as a histogram metric; its span attribute for the identical measurement is
          <code>gen_ai.response.time_to_first_chunk</code>. For specification-clean spans, alias the value
          across with no conversion. The SDK's legacy mode emits the same measurement in milliseconds under
          a different key, so moving between its two modes changes units by a thousand.</td></tr>
          <tr><td><code>gen_ai.client.operation.time_per_output_chunk</code>, in seconds</td><td>free</td>
          <td></td></tr>
          <tr><td><code>gen_ai.system_instructions</code>, <code>gen_ai.input.messages</code>,
          <code>gen_ai.output.messages</code>, <code>gen_ai.tool.definitions</code>,
          <code>gen_ai.tool.call.arguments</code>, <code>gen_ai.tool.call.result</code></td><td>free when
          input and output recording is on</td><td>The specification's default is that instrumentations
          should not capture these and should offer an opt-in. If you turn them on, prompts and completions
          leave your process in full, and any scrubbing you wrote for your own spans does not cover them.
          Say that accurately in your own documentation rather than implying the traces are clean.</td></tr>
          <tr><td><code>gen_ai.execute_tool.duration</code>, in seconds</td><td>free</td><td></td></tr>
          <tr><td>Call-level root span, its boundaries and its close reason</td><td>wrapper</td><td>No
          specification equivalent exists. The only grouping mechanism is a flat conversation id
          attribute.</td></tr>
          <tr><td><code>gen_ai.conversation.id</code></td><td>wrapper</td><td>Conditionally Required when
          readily available, and it is: the call identifier arrives on the <code>setup</code> payload.</td></tr>
          <tr><td>Turn span, its name, its start instant and its end instant</td><td>wrapper</td><td>On
          voice both instants are yours. On messaging only the start is.</td></tr>
          <tr><td>Caller-side span and its back-dating</td><td>wrapper</td><td>Uncovered by the
          specification today. The closest proposal is the unmerged user-input span in PR 394.</td></tr>
          <tr><td>Transcript-received event and transcript size</td><td>wrapper</td><td></td></tr>
          <tr><td>Prompt fetch, memory composition, prompt composition and tool resolution
          steps</td><td>wrapper</td><td>These are your preamble. Measured as a ceiling of 84 ms across 33
          generations in one day with one caller and one model, which makes it a bound on your own overhead
          and not a benchmark of anything.</td></tr>
          <tr><td>Time to first token, on the first non-empty text delta</td><td>wrapper</td><td>Do not
          reuse the SDK's first-chunk number for this. A turn that opens with a tool call streams
          tool-argument chunks with nothing audible for hundreds of milliseconds, so the SDK's first chunk
          and the caller's first word are different events.</td></tr>
          <tr><td>Two time origins under two attribute prefixes, one turn-relative and one
          stream-relative</td><td>wrapper</td><td>Mixing them under one prefix makes first-token-later-than-total
          reachable, and it happens on a prompt-cache miss.</td></tr>
          <tr><td>Server-side time-to-first-audio proxy</td><td>wrapper</td><td>Name it honestly as a floor.
          It cannot see synthesis or the media leg.</td></tr>
          <tr><td>Bot-output span, back-dated from the first delta to the output
          boundary</td><td>wrapper</td><td></td></tr>
          <tr><td>Turn-ending classification, including the barge-in case</td><td>wrapper</td><td>The
          standard-track name for this is proposed in PR 390 and is not merged.</td></tr>
          <tr><td>Error status on the turn span</td><td>wrapper</td><td>If you keep the span open past your
          callback so you can end it yourself, the tracing helper's own error marking no longer runs, and
          status writes after end are dropped in silence. A turn whose prompt fetch threw exported an unset
          status where the helper's own ending would have exported an error status with a message.</td></tr>
          <tr><td>Tool spans for tools the library supplies</td><td>wrapper</td><td>Wrap each tool around
          its own <code>implementation</code>, or instrument at the model runtime. There is no hook.</td></tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The tiling
    property, which is what makes a voice trace worth opening</h3>

    <p class="lede-sm">A voice trace is worth having only if the timeline accounts for the call. The first
    version of this instrumentation did not. On one real call of 57.5 seconds with six turns, the spans
    covered 12.2 seconds and left 45.3 seconds unexplained. That reads to anyone opening the trace as
    proof the instrumentation does not work, when in fact every span was correct and the intervals between
    them belonged to nobody.</p>

    <p class="lede-sm">The shape that fixes it is two span families that alternate. A turn span covers
    prompt receipt to the end-of-turn marker leaving the socket. A caller-side span covers every instant
    between two turns, back-dated to the previous output boundary and closed at the next prompt receipt.
    On one real call after the change, the root covered 42675 milliseconds with 86 observations across six
    turns, and the gap between every consecutive root child was zero milliseconds across all eleven
    boundaries. That is one call, one caller, one direction, so read it as a proof that the shape closes
    rather than as a distribution.</p>

    <p class="lede-sm">Two residuals survive and both are explainable rather than swept up. At the head,
    turn one is back-dated by one millisecond, because the prompt-receipt timestamp is captured before the
    root span is created lazily, and that sign is the correct one. At the tail, 2394 milliseconds separate
    the last end-of-turn marker from socket close, which is the final reply still playing plus the hangup,
    and nothing running in this process can see inside it.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The two relationships that are not what they look like</p>
      <p>The caller-side span hangs off the call-level root, not off the turn it precedes. It ends where
      the turn begins, so nesting it under the turn would draw a child that starts before and ends at its
      parent's start. Because voice turns are minutes of independent WebSocket frames with no async
      context held open across them, the caller-side span also re-extracts the serialised trace parent
      from the root rather than inheriting the ambient context, even though the ambient context at that
      moment is the turn span.</p>
      <p>The model-stream span sits in the tree above the model SDK's <code>invoke_agent</code> span and
      looks like its parent. It is not. Starting an observation without making it the active context
      creates the span but does not enter it, so <code>invoke_agent</code> names the turn span as its
      parent, exactly as the prompt-fetch step does. That was verified by reading the recorded parent span
      identifiers, not by looking at the rendered waterfall, which draws something that reads as nesting.
      The model-stream span is a timer running alongside the model call. Do not draw or assert containment
      between them, and if you publish the tree, publish it this way, because an earlier revision of this
      project's own notes had it wrong.</p>
      <p>One more relationship, stated because it is a negative result rather than a shape: the
      time-to-first-audio proxy landed within zero to three milliseconds of time to first token on all six
      turns of that call. That is not a measurement of audio. It proves that nothing queues between the
      model and the socket, which follows from the library's synchronous per-chunk send, and it remains
      blind to synthesis and playback, which is the part the caller hears.</p>
    </div>
  </section>
