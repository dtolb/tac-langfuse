  <!-- ============ 03 WHAT IT CANNOT SEE ============ -->
  <section id="limits">
    <h2><span class="num">03</span> <b>What it cannot see</b> &middot; and how it fails silently</h2>

    <p class="lede-sm">Everything above is measured by a Node process that receives text frames over a
    WebSocket and sends text frames back. Three quantities a voice engineer actually wants sit on the other
    side of that boundary, and no amount of span work in this process will produce them.</p>

    <div class="cards">
      <div class="card" style="--acc:var(--plat)">
        <h4>Speech synthesis time</h4>
        <span class="api">no acknowledgement exists on the socket</span>
        <ul>
          <li>ConversationRelay accepts <code>text</code> frames and turns them into audio inside Twilio.
          The protocol's application-to-Twilio message set contains no acknowledgement of any kind, so the
          moment a token becomes sound is never reported back.</li>
          <li>Twilio does measure it. The Voice Insights ConversationRelay event
          <code>tts_latency</code> is defined as the time from receiving a text sentence to the start of
          audio synthesis.</li>
          <li>That definition is also the only public hint that tokens are aggregated to sentence
          boundaries before synthesis, and a hint is all it is. No protocol page states an aggregation
          rule.</li>
        </ul>
        <p class="when">Treat sentence buffering as an inference from a metric definition</p>
      </div>
      <div class="card" style="--acc:var(--plat)">
        <h4>Audio playback time</h4>
        <span class="api">subscribable in TwiML, discarded before your callback</span>
        <ul>
          <li>The <code>&lt;ConversationRelay&gt;</code> verb exposes an <code>events</code> attribute
          whose documented values include <code>speaker-events</code> and <code>tokens-played</code>, which
          sounds like the missing signal.</li>
          <li>It is not reachable through the library as shipped. In 2.2.0 the inbound validator is a union
          of exactly the setup, prompt and interrupt schemas; a frame that fails the union is debug-logged
          and dropped, and a frame that parses with an unrecognised type reaches a default branch that logs
          and returns. Those two strings appear in the bundle only inside a documentation comment on the
          TwiML field.</li>
          <li>2.3.0 widens that union by one member, for keypad digits, and nothing else.</li>
        </ul>
        <p class="when">Subscribing today delivers frames the library discards</p>
      </div>
      <div class="card" style="--acc:var(--plat)">
        <h4>Recognition endpointing</h4>
        <span class="api">a platform decision you observe only as its outcome</span>
        <ul>
          <li>Twilio owns transcription end to end. The application influences it only through TwiML at
          call setup, through the provider and model choices, hints, and the endpointing knobs
          <code>speechTimeout</code> at 600 to 5000 ms with a default of <code>auto</code>, plus
          <code>eotThreshold</code> and <code>partialPrompts</code> on one provider model.</li>
          <li>Raw audio never reaches the application, so the interval between the caller falling silent
          and the prompt frame arriving is invisible.</li>
          <li>Two further delays hide beneath even that floor, both visible in the shipped bundle: the
          prompt handler awaits memory retrieval before invoking your callback, and prompt frames for one
          conversation are serialised through a private promise chain.</li>
        </ul>
        <p class="when">The first honest timestamp is prompt-callback entry, and it is a floor</p>
      </div>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The tempting mistake, which this design made before catching it</p>
      <p>A server-side proxy for time to first audio, anchored on the first non-empty text delta leaving
      the socket, landed within 0 to 3 milliseconds of time to first token on all six turns of the one
      instrumented call: 2667 against 2664, 484 against 481, 1201 against 1201, 1655 against 1654, 547
      against 546, and 3499 against 3498, all in milliseconds, from one call with one caller in one
      direction.</p>
      <p>That agreement is real and worth having, because it proves a negative:
      <code>sendStreamingResponse</code> performs a synchronous <code>ws.send</code> inside its own
      <code>for await</code> loop, so nothing queues between the model stream and the socket. What it does
      not prove is anything about audio. The two numbers agree precisely because they measure the same
      event twice on the same side of the boundary. <b class="warn">Presenting that proxy as time to first
      audio publishes a figure that excludes synthesis, network transit and playback,</b> which is the
      entire part a caller hears.</p>
      <p>To get the real numbers a reader has to leave this process. Voice Insights publishes the
      ConversationRelay event family, which includes <code>stt_latency</code> and <code>tts_latency</code>
      with a <code>latency_ms</code> field, <code>first_token_received</code> documented as marking the end
      of application latency, <code>final_token_received</code> with token and word totals, and start and
      end events for both agent speech and customer speech. Those events are emitted at the carrier edge,
      so a query not scoped to that edge returns nothing at all. The alternative, mark events on a Media
      Streams connection, means adopting a different TwiML verb and leaving the managed relay path, so it
      is a replacement rather than an addition.</p>
    </div>

    <p class="lede-sm">Where the protocol documentation is simply silent, this page says so rather than
    estimating. No public page fetched during this work states a deadline for the application to send its
    first text frame after a prompt, a WebSocket idle or ping timeout, any time-to-first-token target, the
    numeric maximum call duration behind error 64104, or the numeric concurrency limit behind 64109. No
    page states whether tokens already sent but not yet spoken are discarded when a barge-in arrives; the
    only observable contract is <code>utteranceUntilInterrupt</code>, the text the caller actually heard,
    from which the truncation point is inferred. Absence of documentation is not absence of a limit, and
    none of those gaps is filled with a guess here.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">One span family
    is a blend, and reading it as caller speech will mislead you</h3>

    <p class="lede-sm">The tiled timeline alternates two span families with no gap between them. The family
    covering everything between the end of one bot response and the arrival of the next prompt was 27622 ms
    of a 42675 ms root span on the instrumented call, which is 65 percent of the call. That is a single
    call with a single caller in one direction, and it is the largest number this design produces, which
    makes it the most likely to be quoted badly.</p>

    <p class="lede-sm">It cannot be read as how long the caller talked. Four distinct things live inside it.
    The bot's own audio is still playing at the start of it, because playback continues past the last token
    this process sent, as the 2394 ms tail above shows. The caller then speaks. Recognition endpointing adds
    its configured silence window after the caller stops, which by default the application does not even
    choose. And on the first turn of a conversation the library's memory retrieval round trip lands inside
    it too, because retrieval is awaited before the prompt handler is invoked and voice runs retrieval once
    per conversation, so that network call sits in the preceding interval rather than in the turn it
    serves.</p>

    <p class="lede-sm">Local token streaming, by contrast, was 150 to 804 ms per turn on that same call,
    which is the measurement that establishes the 65 percent is not this process being slow. The honest
    description of the blended span is a coverage device: it exists so that the sum of the root's children
    equals the root, which turns the question of where the time went from an investigation into a
    subtraction. It is not a caller-behaviour metric, and any dashboard that averages it is averaging four
    unrelated things.</p>

    <p class="lede-sm">Worth knowing for anyone designing this from scratch rather than copying it: the
    OpenTelemetry GenAI conventions arrive at the same shape independently in an open, unmerged proposal.
    <a href="https://github.com/open-telemetry/semantic-conventions-genai/pull/394">PR 394</a> argues that a
    live session streaming audio in both directions cannot be represented by a single client-timed inference
    span, models the session as events correlated by <code>gen_ai.conversation.id</code> rather than as a
    span, and proposes an opt-in span for user input bounded by voice-activity events. A separate proposal,
    <a href="https://github.com/open-telemetry/semantic-conventions-genai/pull/390">PR 390</a>, introduces an
    end-reason attribute intended to capture barge-in as a turn outcome. Neither is merged, so this is
    convergent prior art rather than conformance, and both should be re-checked before anyone builds on
    them.</p>
    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Failure
    modes</h3>

    <p class="lede-sm">Broken telemetry rarely announces itself. The characteristic symptom is a trace that
    looks complete, because the span that went missing is one nobody counts. Every row below was hit during
    this work.</p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:900px">
        <thead>
          <tr><th>Assumption</th><th>Reality</th><th>Symptom you would actually see</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>A span created with a plain OpenTelemetry tracer reaches the backend.</td>
            <td>The vendor span processor filters by span type, admitting spans from its own tracer, spans
            carrying a <code>gen_ai.</code> attribute, and spans from instrumentors it recognises.
            Everything else is dropped on export.</td>
            <td>The turn span is absent while the model spans beneath it arrive, so the trace renders as a
            set of orphans and looks like a parenting bug rather than a dropped export.</td>
          </tr>
          <tr>
            <td>Custom attributes can be set at the top level of a span.</td>
            <td>The vendor attribute builder destructures a fixed key set and discards the rest silently.
            Custom keys must nest under a metadata field.</td>
            <td>The attribute is set without error, the span arrives, and the field is simply not there.
            Nothing logs.</td>
          </tr>
          <tr>
            <td>Setting a metadata value to null records a null.</td>
            <td>The serialiser keeps a key only if the serialised value is truthy, so null and empty string
            vanish while false and zero survive.</td>
            <td>A field meaning "measured, and the answer is nothing" is indistinguishable from a field that
            was never written.</td>
          </tr>
          <tr>
            <td>A span that is created will be exported.</td>
            <td>A span that is never ended is never exported at all.</td>
            <td>The child spans arrive and their parent does not, so the trace has a hole exactly where the
            summary attributes live.</td>
          </tr>
          <tr>
            <td>Flushing the tracer provider before exit works.</td>
            <td>The globally registered provider is a proxy with no flush method, so the obvious call is an
            optional-chained no-op. The flush has to go through the delegate.</td>
            <td>Short-lived processes and scripts produce an empty backend with no error on either side.</td>
          </tr>
          <tr>
            <td>A signal handler in the preloaded instrumentation module can shut the SDK down.</td>
            <td>A preload's signal listener runs before the application's own, so provider teardown races
            the code that ends the root spans, and a span ended on a torn-down provider is dropped in
            silence.</td>
            <td>Roots go missing on clean shutdown but not in development, which reads as an export problem
            rather than an ordering problem.</td>
          </tr>
          <tr>
            <td>The barge-in handler is the right place to close the turn span.</td>
            <td>The interrupt callback fires immediately after the stream task is cancelled, while the
            turn's own completion still needs the stream drain, and attribute writes after a span ends
            return early without error.</td>
            <td><b class="warn">A barged-in turn appears with no output text, no tool list and no total,</b>
            on the one turn ending that is ordinary operation for a phone call.</td>
          </tr>
          <tr>
            <td>The barge-in handler at least inherits the ambient trace context.</td>
            <td>The library dispatches that callback from its own WebSocket message handler, so there is no
            active context to inherit.</td>
            <td>Every barge-in produces a second, single-span trace, and the call's own trace looks like the
            interrupt never happened.</td>
          </tr>
          <tr>
            <td>Taking ownership of when a span ends is free.</td>
            <td>The vendor helper sets error status and then ends the span, so a caller that ends it first
            loses the status.</td>
            <td>A turn whose prompt fetch threw exports with an unset status and no message, and error-rate
            panels read clean while callers heard a failure.</td>
          </tr>
          <tr>
            <td>The prompt-version link is carried on telemetry metadata, as in older recipes for this
            model SDK.</td>
            <td>The current major version has no metadata field on its telemetry options at all, and the
            link object must be a plain object with a numeric version rather than the JSON string the
            prompt client's serialiser returns. Neither half errors.</td>
            <td>The prompt version's metrics view stays empty, which reads as a problem with the tracing
            backend.</td>
          </tr>
          <tr>
            <td>A hand-set prompt link on any span will be picked up.</td>
            <td>The backend computes the prompt name and version only for generation-type observations and
            writes null for others.</td>
            <td>The attribute is present and correct on the wire and absent in the product, verified by
            inspecting the datastore directly.</td>
          </tr>
          <tr>
            <td>Starting an observation makes it the active span, so nesting follows the code.</td>
            <td>The vendor's start helper creates an observation without activating it, so a span opened
            alongside a model call does not contain it.</td>
            <td>A published waterfall diagram shows the wrong tree, and the reader who copies it cannot
            reproduce it.</td>
          </tr>
          <tr>
            <td>A test with an in-memory exporter proves the pipeline.</td>
            <td>An in-memory exporter sees spans the real processor's filters would drop, and a bare tracer
            provider without an async context manager makes context activation a silent no-op.</td>
            <td>Tests pass, and the first live run reports six trace identifiers for one call.</td>
          </tr>
          <tr>
            <td>The tracing backend's absence of trace data means no traces were recorded.</td>
            <td>In this configuration the public read endpoints for traces return 404 because the read API
            is disabled, not because the store is empty.</td>
            <td>An automated verification step reports zero traces while the traces are plainly visible in
            the user interface.</td>
          </tr>
          <tr>
            <td>The instrumentation is running because the code is committed.</td>
            <td>The container image copies source at build time rather than mounting it, so a code change
            reaches production only on rebuild.</td>
            <td><b class="warn">A real call placed against an image built hours earlier comes back missing
            every new span,</b> which reads as proof the instrumentation does not work rather than proof the
            code was never deployed. Check the image build time against the commit before anything
            else.</td>
          </tr>
          <tr>
            <td>Restarting the container picks up the changed configuration.</td>
            <td>A restart re-runs the container with its original environment block, so the change silently
            does not take. Recreation is required.</td>
            <td>The variable is set on disk, the process disagrees, and every hypothesis you form next is
            about the wrong layer.</td>
          </tr>
          <tr>
            <td>A running process picks up the fix.</td>
            <td>This runtime does not hot-reload code, though prompt edits fetched from the tracing backend
            do land live within a cache interval.</td>
            <td>A verification run reports the old behaviour because the process predates the fix by an
            hour, and the fix gets reverted as ineffective.</td>
          </tr>
          <tr>
            <td>Awaiting anything between the turn function resolving and the token drain is harmless.</td>
            <td>The budget is one macrotask. One resolved-promise await still wins; two lose, and so does
            any await that itself awaits.</td>
            <td>Time to first token and turn total report null while the caller hears the entire answer,
            because the timing span closed before the stream drained.</td>
          </tr>
          <tr>
            <td>A per-conversation timeline can be keyed by conversation identifier alone.</td>
            <td>A handler can outlive the start of the next turn, and orchestrated conversations reuse one
            identifier per caller profile.</td>
            <td>The straggling handler closes the wrong turn: one turn exports with a 10 ms duration
            carrying the previous turn's timings, and its own close silently no-ops.</td>
          </tr>
          <tr>
            <td>The model SDK's span and attribute names are stable across its major versions.</td>
            <td>The current version emits GenAI-convention span names, so anything keyed on the previous
            version's names finds nothing. Its legacy mode also reports time to first chunk in milliseconds
            where the current mode reports seconds.</td>
            <td>A dashboard silently matches zero spans, or a latency chart is wrong by a factor of one
            thousand with no error anywhere.</td>
          </tr>
          <tr>
            <td><code>gen_ai.client.operation.time_to_first_chunk</code> is a span attribute in the
            specification.</td>
            <td>The specification defines that exact name, in seconds, as a metric histogram. The span
            attribute for the identical measurement is
            <code>gen_ai.response.time_to_first_chunk</code>. The model SDK emits the metric name as a span
            attribute, so the name and unit are right and the signal is wrong.</td>
            <td>A conformant query against the specification's span attribute returns nothing, and a metrics
            pipeline expecting a histogram receives none.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="lede-sm">Two of those rows deserve emphasis because they are indistinguishable from a code
    defect and they cost real time. Instrumentation that was never deployed reads exactly like
    instrumentation that does not work: the trace arrives, the call succeeded, and the new spans are simply
    absent. Instrumentation running in a process older than the fix reads the same way. Before forming any
    hypothesis about the tracing code, compare the running process or image against the commit that
    introduced the change.</p>

    <p class="lede-sm">One caveat on the whole specification column. The GenAI conventions moved out of the
    main semantic-conventions repository into
    <a href="https://github.com/open-telemetry/semantic-conventions-genai">their own repository</a>, whose
    manifest declares <code>stability: development</code> and a <code>gen-ai-dev</code> schema URL, with no
    tagged release. Every <code>gen_ai.*</code> attribute, span, metric and event is badged Development;
    the only stable attributes on a GenAI span are borrowed from core conventions. The registry changed on
    the day it was read for this work. Nothing here should be treated as a stable target.</p>
  </section>
