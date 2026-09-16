  <!-- ============ 05 TELEMETRY ============ -->
  <section id="otel">
    <h2><span class="num">05</span> <b>Instrumenting it with OpenTelemetry</b> &middot; what silently produced nothing</h2>

    <p class="lede-sm">Every lesson here shares one shape: the code was correct, the span was created, and
    nothing arrived. None of them raise, and none of them are visible in a unit test.</p>

    <p class="lede-sm">This is the tree one voice turn produces. Read it before writing an assertion about
    nesting, because two of the relationships are not what they look like.</p>

<pre><b>conversation</b>                             <i>is_app_root, closedBecause: ended</i>
+- <b>caller.turn</b>                           <i>0 ms gap to the next child, by construction</i>
+- <b>turn.voice</b>                            <i>prompt received to last token sent</i>
|  +- <b>prompt.fetch</b>                       <i>41 ms, version and label on the span</i>
|  +- <b>memory.recall</b>                      <i>79 ms, chars: 4412</i>
|  +- <b>prompt.compose</b>                     <i>historyMessages: 2</i>
|  +- <b>tool.selection</b>                     <i>5 of 5 tools resolved</i>
|  +- <b>llm.stream</b>                         <u>a timer running alongside, NOT the parent</u>
|  +- <b>invoke_agent</b>                       <i>AI SDK, parented to turn.voice directly</i>
|  |  +- step 1 <i>-&gt;</i> <b>chat &lt;model&gt;</b>          <i>gen_ai.client.operation.time_to_first_chunk</i>
|  |  +- <b>execute_tool</b> search_knowledge   <i>417 to 1018 ms</i>
|  |  `- step 2 <i>-&gt;</i> <b>chat &lt;model&gt;</b>          <i>composes what the caller hears</i>
|  `- <b>tts.send</b>                           <i>150 to 804 ms</i>
`- <b>caller.turn</b>                           <u>a blend: playback, speech, endpointing</u></pre>

    <div class="lblock" style="margin-top:26px">
      <h3>A &middot; The export pipeline</h3>
      <div class="tablewrap">
        <table class="wide-first">
          <thead>
            <tr><th>The assumption</th><th>What is actually true</th><th>Symptom</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Any OpenTelemetry span reaches the backend</td>
              <td>The span processor forwards only spans that pass its own filters for its span types.</td>
              <td>The span is created correctly, is visible to an in-memory exporter, has a real sampled
              trace id, and never arrives. This is the single most expensive finding on the page.</td>
            </tr>
            <tr>
              <td>Custom attributes ride at the top level</td>
              <td>The attribute builder destructures a fixed key set. Anything custom has to nest under
              metadata, where the key is preserved verbatim.</td>
              <td>The attribute is simply absent, with no warning.</td>
            </tr>
            <tr>
              <td>A flush on the global provider works</td>
              <td>The tracer provider you get back is a proxy with no flush method, so an optional call
              resolves to nothing. Flush through its delegate.</td>
              <td>Spans are lost at exit and the code reads as if it flushed.</td>
            </tr>
            <tr>
              <td>Metadata values round-trip</td>
              <td>The serializer's guard is truthiness, so false and an empty array survive while null is
              dropped.</td>
              <td>A deliberately null field produces no attribute rather than an explicit null.</td>
            </tr>
            <tr>
              <td>Flush, then shut down</td>
              <td>An unended span never arrives, so the conversation has to be closed before the flush.</td>
              <td>Flushing first ships every turn while dropping the conversation they hang from.</td>
            </tr>
            <tr>
              <td>Missing spans mean broken instrumentation</td>
              <td>A container image copies the source at build time rather than mounting it.</td>
              <td>A real call against a stale image returns a trace with none of the new spans, which
              reads as "the instrumentation does not work" instead of "the code was never deployed".</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="lblock">
      <h3>B &middot; Linking and nesting</h3>
      <div class="tablewrap">
        <table class="wide-first">
          <thead>
            <tr><th>The assumption</th><th>What is actually true</th><th>Symptom</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Wrapping the model call in your own span parents it</td>
              <td>Starting an observation does not make it the active context, so the SDK's spans parent
              to the turn span instead.</td>
              <td>Your span is a timer running alongside, which is why its duration and the model span's
              are near identical rather than nested. An earlier version of our own diagram drew this
              wrongly, and reading the parent id settled it.</td>
            </tr>
            <tr>
              <td>The prompt link goes in telemetry metadata</td>
              <td>That field does not exist on the current SDK. The link rides on runtime context, must be
              opted into, and must be a plain object with a string name and a numeric version.</td>
              <td>A stringified version is discarded with no warning and the metrics view stays empty.</td>
            </tr>
            <tr>
              <td>Any span can carry the prompt version</td>
              <td>Ingestion computes the prompt link only for generation observations.</td>
              <td>Per-version latency aggregation works at the model-call level with a native
              time-to-first-token column, while turn-level timings are filterable but not aggregated.</td>
            </tr>
            <tr>
              <td>Span names start with the SDK's own prefix</td>
              <td>They follow the OpenTelemetry generative-AI convention.</td>
              <td>Anything keyed on the old prefix matches nothing.</td>
            </tr>
            <tr>
              <td>An in-memory exporter proves the pipeline</td>
              <td>It cannot exercise the real processor's filters, and a bare provider makes context
              propagation a no-op.</td>
              <td>The first harness run reported six trace ids for one call. It needs an async context
              manager and a propagator, and the live stack is still the only real proof.</td>
            </tr>
            <tr>
              <td>A 404 from the read API means no data</td>
              <td>In events-only mode the trace read API is disabled and answers 404 by design.</td>
              <td>You go chasing a telemetry bug that does not exist. Verify in the UI, or read the event
              tables directly.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Say this accurately: the traces contain personal data</p>
      <p>The app's own spans and events pass through a scrubbing hook. The model's spans do not: they carry
      the full prompt and the full completion, which on these channels includes whatever the caller said
      and whatever memory was injected. The memory store holds personal data too, since profile traits
      include a phone number and observations are prose taken from the transcript.</p>
      <p>So this stack must not be described as keeping personal data out of the observability layer. What
      is true is narrower: log lines and the app's own event payloads are scrubbed, and the tool layer
      projects communications down and drops recipients, with a test asserting it.</p>
    </div>
  </section>
