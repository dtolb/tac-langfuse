  <!-- ============ 05 OPEN ITEMS ============ -->
  <section id="open">
    <h2><span class="num">05</span> <b>Open items</b> &middot; every claim that rests on reading</h2>

    <p class="lede-sm">This page mixes three kinds of evidence and they are not interchangeable. Some claims
    were measured on real traffic. Some were compiled against real declared types and never run. Some were
    read out of a shipped bundle or a documentation page and reasoned about. Each row below says which, so a
    reader can decide what to trust and what to re-check.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Numbers, and how
    thin the sample is</h3>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:760px">
        <thead>
          <tr><th>Claim</th><th>What it rests on</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>The tiling result: a 42675 ms root, 86 observations, six turns, zero-millisecond gaps across
            eleven boundaries, a 27622 ms blended span at 65 percent of the call, 150 to 804 ms per-turn
            streaming, a one-millisecond head residual and a 2394 ms tail.</td>
            <td><b class="warn">One call, one caller, one direction.</b> An existence proof that the shape
            closes, not a distribution. The 57.5 s, 12.2 s and 45.3 s before-figures come from one earlier
            call.</td>
          </tr>
          <tr>
            <td>The 84 ms preamble ceiling, and the claim that time to first chunk accounts for the
            generation span almost exactly.</td>
            <td>33 generations from a single day, a single caller and a single model. A ceiling from the
            worst single turn, with a range of 0 to 84 ms. Not a benchmark.</td>
          </tr>
          <tr>
            <td>The zero-to-three-millisecond agreement between the first-audio proxy and time to first
            token.</td>
            <td>Six turns of that one call.</td>
          </tr>
          <tr>
            <td>The barge-in branch of the span model and of the instrumentation.</td>
            <td><b class="warn">Unproven on live traffic.</b> Both measured real calls recorded zero aborted
            turns and no interrupt event, so the park-the-boundary mechanism is evidenced by a test suite, a
            harness run and a diagnostic script. One call in which somebody talks over the agent would close
            it.</td>
          </tr>
          <tr>
            <td>The parent-identifier claims, including that the model-stream span does not contain
            <code>invoke_agent</code>.</td>
            <td>The tracing backend in use exposes no public read API, so shapes were verified in the
            datastore and the user interface rather than through a read endpoint. That matters because an
            in-memory span exporter cannot exercise the real export pipeline's filtering.</td>
          </tr>
          <tr>
            <td>The measured attribute loss in the naive barge-in version, and the overlapping-handler
            corruption that motivates the owner-span identity check.</td>
            <td>Transcribed from recorded measurements rather than reproduced in this pass. The underlying
            mechanism, that attribute and status writes return early after a span ends, is specified API
            behaviour that was not re-demonstrated.</td>
          </tr>
          <tr>
            <td>The read endpoints for traces returning 404 because the read API is disabled.</td>
            <td>One deployment configuration observed in this work. It is not a general property of the
            product.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Code that
    compiled and did not run</h3>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:760px">
        <thead>
          <tr><th>Layer or claim</th><th>What it rests on</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Layer 1, the exporter and provider.</td>
            <td>Never executed. The OTLP exporter package was not a direct dependency of the verification
            workspace, so the compiler resolved it through a path alias and running the file failed at
            module resolution. Endpoint construction, header parsing, batching and the flush-through-the-delegate
            path are compiled and reasoned, not observed against a collector.</td>
          </tr>
          <tr>
            <td>That a top-of-file import evaluates too late to patch the library.</td>
            <td>Reasoning about ECMAScript module evaluation order plus the shipped scaffold's use of a
            preload for that stated reason. No experiment was constructed in which a top-of-file import
            demonstrably misses spans a preload catches.</td>
          </tr>
          <tr>
            <td>The signal-handler ordering hazard between the preload and the application.</td>
            <td>Transcribed from the scaffold's recorded measurement, not re-measured. No shutdown race was
            reproduced in which root spans end after provider teardown.</td>
          </tr>
          <tr>
            <td>Layer 2, the callback decorators.</td>
            <td>Typechecked only. Whether the auto-send behaves as the declared string, null or void union
            suggests when handed each of the three return values was not exercised against a live
            channel.</td>
          </tr>
          <tr>
            <td>The callback-slot clobbering hazard on registration.</td>
            <td>Follows from <code>on</code> being a setter and from the internal listener setup calling it.
            Both registration orderings were not run to observe the silent failure.</td>
          </tr>
          <tr>
            <td>Layer 4, the tool decorator.</td>
            <td>Typechecked only. Never run with a model runtime dispatching a real tool call, so its timing
            attribute and its error path are compiled rather than observed.</td>
          </tr>
          <tr>
            <td>That <code>TACTool.implementation</code> is read in exactly two places.</td>
            <td><b class="warn">Not established.</b> The count comes from a prior grep of the shipped
            bundle, and a later independent check found the string in seven places, which is consistent with
            but does not prove two read sites. Someone should confirm them by name.</td>
          </tr>
          <tr>
            <td>The layer 5 voice wiring module.</td>
            <td>Typechecked only, not run against a live channel. Its use of
            <code>sendStreamingResponse</code> and <code>getWebsocket</code> was re-verified against the
            shipped type declarations in this pass.</td>
          </tr>
          <tr>
            <td>The harness import paths for the context manager and the propagator.</td>
            <td>Rewritten from transitive paths to package names after confirming both packages export the
            named symbols. Neither was a direct dependency of the verification workspace, so a reader
            installing them fresh is on a path that was not exercised.</td>
          </tr>
          <tr>
            <td>That supplying a custom logger bypasses the library's own scrubbing log hook.</td>
            <td>Derived from reading the logger factory and the assignment site, not exercised at runtime.
            Whether a caller-supplied logger reaches every logging site was not traced to every construction
            site; at least two internal clients fall back to their own logger when constructed without
            one.</td>
          </tr>
          <tr>
            <td>That the first turn's memory retrieval lands inside the preceding caller-gap span, and the
            effect of prompt-frame chaining under an added network hop.</td>
            <td>Read from the shipped bundle's ordering rather than observed in a trace during this
            pass.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Specifications,
    documentation, and documented silence</h3>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:760px">
        <thead>
          <tr><th>Claim</th><th>What it rests on</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Every <code>gen_ai.*</code> name used on this page.</td>
            <td>The GenAI conventions were read at a single commit on an untagged development registry with
            no releases. Every attribute is badged Development and the registry changed within a day of
            being read. <b class="warn">Re-check the names before publishing</b>, particularly the recently
            added conversation id on tool spans.</td>
          </tr>
          <tr>
            <td>That the two open GenAI voice proposals are still open.</td>
            <td>Not re-checked at publication time. One of them was active the day before the source read,
            so either may since have merged, closed or been superseded.</td>
          </tr>
          <tr>
            <td>The list of attributes arriving free from the model SDK.</td>
            <td>Read from the installed SDK's telemetry documentation, not from a diff of a live trace
            against that list. Individual attributes may be absent for a given provider or call shape. An
            intermediate step-numbered span appears in this project's earlier notes; whether that is a
            separate span or a rendering artifact of the tracing user interface was not settled.</td>
          </tr>
          <tr>
            <td>That tokens are buffered to sentence boundaries before synthesis.</td>
            <td>Inferred from the Voice Insights definition of the synthesis latency event. No protocol page
            states it as a rule.</td>
          </tr>
          <tr>
            <td>That tokens already sent but not yet spoken are discarded on a barge-in.</td>
            <td>Not stated on any page fetched. The truncation point is inferred from
            <code>utteranceUntilInterrupt</code>.</td>
          </tr>
          <tr>
            <td>What the TwiML-subscribed speaker and playback event frames would contain.</td>
            <td>Unknown. Their payload field names do not appear on any page fetched, so what the library
            would dispatch if it accepted them cannot be described.</td>
          </tr>
          <tr>
            <td>The absence of a first-frame deadline, a WebSocket idle or ping timeout, a
            time-to-first-token target, a numeric maximum call duration behind error 64104, and a numeric
            concurrency limit behind 64109.</td>
            <td>Absence across the pages fetched, not a documented guarantee that no limit exists.</td>
          </tr>
          <tr>
            <td>Voice Insights and Media Streams as the routes to real synthesis and playback timings.</td>
            <td>Not exercised. They are named on the strength of published event definitions, not on a
            measurement taken through them. That Media Streams mark events require abandoning the managed
            relay path is read from the TwiML verb documentation rather than tested by building both.</td>
          </tr>
          <tr>
            <td>That a library depending only on <code>@opentelemetry/api</code> costs nothing when no SDK
            is registered.</td>
            <td>Standard documented behaviour for that package, not something benchmarked here.</td>
          </tr>
          <tr>
            <td>That the maintainers would treat a change to the callback signatures as breaking.</td>
            <td>Inferred from one release note's semantic-versioning reasoning and the 1.x to 2.x history.
            No written policy exists and no maintainer was asked.</td>
          </tr>
          <tr>
            <td>Statements about what the published API reference does or does not claim.</td>
            <td>The rendered reference could not be inspected because its documented URL returns 404, so
            those statements are inferred from the documentation generator configuration and internal tags
            in source.</td>
          </tr>
          <tr>
            <td>That a private staging repository targets the voice provider layer.</td>
            <td>That repository's public name and description only. No readable code, plan or maintainer
            statement behind it.</td>
          </tr>
          <tr>
            <td>The 2.2.0 to 2.3.0 delta.</td>
            <td>Taken from release notes, the pull request body and the export barrel rather than from a diff
            of two installed bundles.</td>
          </tr>
          <tr>
            <td>Whether any candidate agent builder accepts or propagates an inbound W3C
            <code>traceparent</code> on its streaming endpoint.</td>
            <td><b class="warn">Unknown.</b> The join passage in section 04 states the risk and does not
            resolve it.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
