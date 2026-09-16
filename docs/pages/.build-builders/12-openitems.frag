  <!-- ============ 09 OPEN ITEMS ============ -->
  <section id="open">
    <h2><span class="num">09</span> <b>Open items</b> &middot; what rests on reading rather than on running</h2>

    <p class="lede-sm">Nothing in this section is a hedge on a number quoted above, because every figure on this
    page carries its caveat where it is used. These are the claims resting on documentation rather than
    measurement, and the questions left unsettled.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The one that governs every other row</p>
      <p><b class="warn">Nothing here was run.</b> Every candidate claim comes from reading source at a named
      commit or from published documentation. No container was started, no call was placed against any builder,
      and no token cadence was observed on any wire. Every latency figure is transcribed from this repository's own
      recorded measurements rather than re-measured for this page.</p>
    </div>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:800px">
        <thead>
          <tr><th>Claim or question</th><th>What it rests on</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>That the transport cost of shape (b) across a local bridge is small relative to model time.</td>
            <td>The measured model figures plus an unmeasured assumption that a small-body local request costs
            single-digit milliseconds. <b class="warn">The hop itself was never measured.</b></td>
          </tr>
          <tr>
            <td>Any comparison of a candidate against the 84 ms preamble ceiling.</td>
            <td>Not possible yet. No candidate's internal pre-model latency was measured, so no candidate can be
            placed against that ceiling.</td>
          </tr>
          <tr>
            <td>The primary recommendation's viability on the voice path.</td>
            <td>The in-process interval from the stream call to the first text delta is unmeasured, and it is the
            single number that decides it. It is also unknown whether the awaited stream promise resolves before
            the first chunk or only after upstream setup, which on voice is the difference between a memory read
            costing time to first audio or not.</td>
          </tr>
          <tr>
            <td>That any surveyed builder produces a byte-stable system-prompt prefix across turns.</td>
            <td>Untested against all of them. The prompt-cache failure mode is reasoned from how prefix caching
            works plus this repository's own measured cold-versus-warm gap on a single call, which is why it is a
            spike step rather than a finding. Related and unresolved for the primary: whether serialised tool
            definitions keep a stable order across runs, since reordering would defeat caching just as surely as
            an unstable prompt.</td>
          </tr>
          <tr>
            <td>That ConversationRelay buffers text to sentence boundaries before synthesis.</td>
            <td>Inference from the published definition of one latency event, as time from receiving a text
            sentence to the start of audio synthesis. It is never stated as a protocol rule, so the conclusion
            that per-sentence chunking would be inaudible is unproven and should not be used to excuse a
            coalescing window.</td>
          </tr>
          <tr>
            <td>The protocol envelope this page relies on being permissive.</td>
            <td>The reference publishes no WebSocket idle timeout, no deadline for the first text frame after a
            prompt, no time-to-first-token target, and no numeric value behind its maximum-call-duration or
            concurrency errors. <b>Absence of documentation is not proof of absence.</b> Whether
            queued-but-unspoken tokens are discarded on interrupt is not stated on any reference page.</td>
          </tr>
          <tr>
            <td>Every negative <code>traceparent</code> verdict for Flowise, Letta Code, Node-RED and Coze
            Studio.</td>
            <td>A repository code search returning zero matches for the string on the date read. That method
            covers source and tests and would miss a capability provided entirely by a dependency, so those are
            strong rather than proven negatives.</td>
          </tr>
          <tr>
            <td>Sim's propagation verdict.</td>
            <td>It was established only that the route wrapper extracts a trace identifier for logging and that
            real propagation exists on an unrelated path. Whether a workflow run could be made to parent its block
            spans to an inbound header was reasoned about and not attempted.</td>
          </tr>
          <tr>
            <td>Windmill's trace pipeline.</td>
            <td>Unresolved which parts work in a plain open-source build, and whether the relationship to an
            inbound trace ends as a parent or as a link. Whether the enterprise build's spans carry prompt or
            completion payloads at all is unknown, because those sources are not in the repository.</td>
          </tr>
          <tr>
            <td>The primary recommendation's trace claim, that its spans parent under the ambient context.</td>
            <td>Read from an example's documentation and from the presence of a propagation module and its unit
            test, not from running the example. <b>The parent-and-child assertion is claimed by the project rather
            than measured here.</b></td>
          </tr>
          <tr>
            <td>The primary recommendation's two open tool-buffering defects.</td>
            <td>Read from the issue tracker with version-pinned reproductions. Their effect on a voice turn, where
            a tool result should reach synthesis the moment it exists, is not quantified.</td>
          </tr>
          <tr>
            <td>Two further details of the primary recommendation.</td>
            <td>The granularity of its payload-suppression policy is unread, so whether a generation span can be
            exported while withholding prompt text is unknown. Whether its memory can be omitted entirely while
            still resolving stored Editor versions looks supported and was not verified.</td>
          </tr>
          <tr>
            <td>Documentation-only claims behind the eliminated candidates.</td>
            <td>Whether Coze Studio's current guards close the SQL-injection advisory was not established, and the
            advisory should be treated as open against the latest release. Whether an open-source Windmill build
            from source compiles and runs the agent step was not attempted; only the absence of enterprise gates in
            that code was confirmed by search. Whether Sim's isolate native addon builds and runs inside the
            published image was not verified, and custom-tool execution on a self-host depends on it. Whether
            Node-RED's async context survives a hop between nodes is unverified and would be the first thing to
            check if it were reconsidered.</td>
          </tr>
          <tr>
            <td>Five candidates that were not assessed and should not be dismissed on the strength of a name.</td>
            <td>LibreChat, Dust and AnythingLLM were named by a completeness review and never assessed at all;
            their licences, streaming shapes, in-builder authoring and OTLP support need the same source-level
            verdict the twelve above received. Bisheng's current licence was never retrieved, and Pipecat Flows'
            editor maturity and licence were never verified against its repository.</td>
          </tr>
          <tr>
            <td>Two measurement disagreements inside this repository's own record, published rather than averaged
            because both are real.</td>
            <td>The memory block's share of the system prompt is 52 percent against a denominator of the base
            prompt plus memory, and 35 percent once the roughly 4035 characters of tool definitions are included,
            and the source does not state which denominator it intended. Prompt-share percentages are characters
            divided by four, a method that predicted about 3132 tokens where the tokenizer reported 2520 on the
            same generation, an overestimate of roughly 24 percent, <b>so the shares are reliable and absolute
            token counts derived that way are not.</b></td>
          </tr>
          <tr>
            <td>The barge-in branch of the current instrumentation, which any comparison rests on.</td>
            <td>Proven only by the test suite and a diagnostic, because both recorded real calls report zero
            aborted turns. One call where somebody talks over the agent would close it.</td>
          </tr>
          <tr>
            <td>The end-to-end viability of feeding the streaming method from a remote runtime.</td>
            <td>Derived from reading the shipped SDK bundle rather than from running it. Abort propagation into a
            remote request, and the serialised turn-boundary behaviour under a remote round trip, were both
            unexercised.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
