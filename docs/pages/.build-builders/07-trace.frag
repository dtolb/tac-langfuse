  <!-- ============ 03 THE TRACE CONSEQUENCE ============ -->
  <section id="trace">
    <h2><span class="num">03</span> <b>The trace consequence</b> &middot; the instrument the latency argument rests on is deleted by the move</h2>

    <p class="lede-sm">This deserves its own section because the instrument the whole latency argument rests on
    is produced by the model SDK running in this process. <b>Moving the model out deletes it</b>, and no bridge
    recovers it.</p>

    <p class="lede-sm">Grepping the shipped Agent Connect bundle for six strings, covering OpenTelemetry, async
    local storage, <code>traceparent</code>, tracer acquisition, W3C and propagation, returns zero matches for
    every one of them. The SDK carries no tracing. Every generation span in a trace today therefore comes from
    the installed model SDK, and <code>gen_ai.client.operation.time_to_first_chunk</code> is a literal string
    inside that package. It is not in anything Twilio ships.</p>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">One specification detail makes that attribute less portable than it looks</p>
      <p>The <a href="https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md">GenAI
      semantic conventions</a> define time to first chunk as a histogram <em>metric</em>, and the span
      attribute for the same measurement is <code>gen_ai.response.time_to_first_chunk</code>. The model SDK in
      use emits the metric name as a span attribute. So a builder that is specification-clean and does emit the
      measurement will emit it under a different key, and <b class="warn">a query written against the current
      spelling reads nothing even in the good case.</b> Those conventions are in development with no tagged
      release, so this should be rechecked rather than trusted, and a spike should search both spellings.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Shape (a) costs the
    trace nothing, which is the strongest position available</h3>

    <p class="lede-sm">A library called inside the existing turn span inherits the parent from the ambient
    context and its spans reach the same exporter, so there is nothing to stitch. The five in-process candidates
    are not equal at it, though. Mastra's bridge does exactly this, parenting under the active context.
    VoltAgent needs an explicit parent-span option, because its trace context deliberately deletes the ambient
    span to force a root and attaches the ambient one only as a link. Node-RED has no span model, so a single
    tree is reachable only by joining it in the host's own code. Rivet contributes no spans at all.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Shape (b) costs two
    disconnected trees, and only one candidate avoids it</h3>

    <p class="lede-sm">Avoiding it takes two things at once: the builder must accept the inbound header
    <em>and</em> record the spans worth having. Accepting the header and then dropping the spans produces a
    single tree with nothing in it, which is not better.</p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:860px">
        <thead>
          <tr><th>Candidate, out of process</th><th>What arrives in the joined trace</th><th>Mechanism</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Dify, the only one that does both</td>
            <td>One tree, with a span per workflow node beneath the turn span.</td>
            <td>A composite propagator installed as the global textmap, an instrumented web framework, and a
            parent-based sampler, so the caller's sampled flag is honoured.</td>
          </tr>
          <tr>
            <td>Langflow, accepts and then drops</td>
            <td>One tree carrying one flow-execution span wrapped in HTTP and database spans, and no
            generation spans at all.</td>
            <td>Its own source says all three signals deny by default on export, that the allowlist admits four
            scopes, that instrumentor spans carry prompt and completion text and must never reach an operator's
            monitoring system, and that <b>the allowlist only ever subtracts</b>, because a setting able to add
            a scope would reopen the leak the allowlist exists to close.</td>
          </tr>
          <tr>
            <td>Windmill</td>
            <td>Two trees.</td>
            <td>The header is captured at job push only, gated on a tracing variable, with the tracer
            initialiser returning nothing and the parenting function empty.</td>
          </tr>
          <tr>
            <td>Sim</td>
            <td>Two trees, and the second one is built after the fact.</td>
            <td>Only the trace id is extracted, for log grepping. Workflow spans are created after the run
            finishes with backdated start times, so there is nothing live to parent.</td>
          </tr>
          <tr>
            <td>Coze Studio</td>
            <td>Not two trees but <b class="warn">one tree with a hole in the middle of a turn.</b></td>
            <td>Zero occurrences of the string, and no spans emitted at all, so there is nothing to attach and
            nothing to attach it to.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">What stops existing when the model call leaves this process</p>
      <ul>
        <li>Input and output token counts, and cache read and cache write tokens.</li>
        <li>The model identity per step, and the prompt and completion text.</li>
        <li>The request issuance instant, which is what makes time to first chunk meaningful at all.</li>
        <li>The prompt-version link, for a reason particular to this stack: <strong>the trace store computes
        the prompt name and version only for observations typed as generations</strong>, so a span the bridge
        synthesises and types as a plain span carries the attribute and resolves to nothing. That behaviour was
        verified by reading the ingested rows directly, because this deployment exposes no public read API for
        traces and a 404 there means disabled rather than empty.</li>
        <li>A local trap compounds all of it. The span processor filters on export by instrumentation scope and
        by the presence of any attribute key beginning <code>gen_ai.</code>, so a span created with a bare
        tracer is created successfully, is visible to an in-memory exporter, and is <b class="warn">silently
        dropped on the way out with no error anywhere.</b></li>
      </ul>
    </div>

    <p class="lede-sm">What survives every shape is the number this repository already measures by hand: time
    to first token, anchored on the first non-empty text delta rather than on the SDK's first chunk, because a
    turn that opens with a tool call streams argument fragments with no audible output for hundreds of
    milliseconds. That measurement answers how long until the caller hears something. It does not answer whether
    a slow turn was the framework or the model, which is precisely what the vanished attribute answered in one
    query.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Shape (c) costs the
    trace nothing at all, and its hybrid variant costs one thing</h3>

    <p class="lede-sm">Shape (c) keeps the tiled voice timeline, the per-turn generation spans and the
    prompt-version link, because nothing about the model call moves. The hybrid variant, where the builder also
    hosts business tools the runtime reaches over HTTP, costs one span: a tool span with a real duration, real
    arguments and no children, so the time inside it is unattributed.</p>

    <p class="lede-sm">On the measured scale, one tool returned in about 1 ms and another took 417 ms to
    1018 ms across a small single-day sample because it queries a knowledge base over the network, so an opaque
    span in that second range is the shape to expect, in the middle of a turn a caller is waiting through.
    Closing that hole means the builder must accept a header on the tool call and continue the trace, and
    whether any surveyed builder does that was not checked.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">A second cost of the hybrid variant, and it is concrete rather than cosmetic</p>
      <p>The tool context passed to an implementation carries a conversation identifier, a logger and a profile
      identifier, and <b>no abort signal</b>. So on barge-in the model stream stops while an in-flight outbound
      tool call keeps running until it completes or times out. That is billable work and a possible write, for a
      turn the caller has already talked over.</p>
    </div>
  </section>
