  <!-- ============ 02 THE FORK ============ -->
  <section id="fork">
    <h2><span class="num">02</span> <b>The fork, in three shapes</b> &middot; and why requirement 3 forces the expensive one</h2>

    <p class="lede-sm">The seam takes an async iterable, so it is indifferent to where the tokens come from.
    That makes the fork a choice between three integration shapes rather than a transport argument, and the
    thing that decides it is not latency. <b>Requirement 3 forces the shape that breaks the trace.</b></p>

    <div class="cards">
      <div class="card" style="--acc:var(--obs)">
        <h4>Shape (a), in process</h4>
        <span class="api">the builder's runtime imported as a Node library</span>
        <ul>
          <li>The prompt handler calls the builder directly and hands the resulting iterable to
          <code>sendStreamingResponse</code>. There is no transport, no serialisation and no second
          process.</li>
          <li>Only five candidates can take it: Mastra, VoltAgent, Rivet, LangGraph JS and Node-RED.</li>
          <li>Of those five, only Node-RED offers any in-builder authoring, and its authoring covers
          implementations while offering no first-party mechanism for tool definitions.</li>
        </ul>
        <p class="when">Costs the trace nothing, and satisfies requirement 3 for nobody</p>
      </div>
      <div class="card" style="--acc:var(--plat)">
        <h4>Shape (b), over a local bridge</h4>
        <span class="api">a separate container reached over a streaming HTTP body</span>
        <ul>
          <li>A generator in this process reads frames and yields text deltas. No new abstraction is needed,
          only a frame reader and an abort forward.</li>
          <li>Every candidate that fully satisfies requirement 3 is a separate service, so this is where
          requirement 3 leads.</li>
          <li>It is also where the trace splits in two, unless the builder both accepts the header and records
          the spans worth having. One candidate of twelve does both, and it fails requirement 1.</li>
        </ul>
        <p class="when">The only shape that satisfies requirement 3, and the one that costs the trace</p>
      </div>
      <div class="card" style="--acc:var(--neutral)">
        <h4>Shape (c), move nothing</h4>
        <span class="api">the builder becomes the authoring surface only</span>
        <ul>
          <li>The TypeScript agent keeps calling the model, holding the WebSocket and dispatching tools. The
          builder is where a human edits the system prompt and picks which tools this version may use,
          publishing that as configuration the runtime fetches.</li>
          <li>This is what the scaffold already runs. Its prompt seam validates a JSON document edited in a web
          form against a strict schema, and that document carries the model identifier, the tool-choice mode, a
          step ceiling and the ordered list of enabled tool names alongside the prompt text.</li>
          <li>Changing the tool selection is a new version plus a label move, with no redeploy and no restart,
          and rollback is moving the label back.</li>
        </ul>
        <p class="when">Requirement 2 stops applying, and requirement 3 is out of reach by construction</p>
      </div>
    </div>

    <p class="lede-sm">Shape (c) is worth stating precisely, because it is easy to undersell and easy to
    oversell. A person can rename a tool's description, reorder the selection, remove a tool from a version and
    roll the whole thing back. <b>What that person cannot do is create a capability the repository did not
    already have</b>, which is requirement 3 in one sentence.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The local hop is not
    the problem, and two named candidates are</h3>

    <p class="lede-sm">What shape (b) costs per turn is one request across a local bridge with a small body,
    plus whatever the builder does before its first model token. Against a healthy tool-free turn measured at
    586 ms to 801 ms of model time to first chunk, from a handful of turns on one day with one caller and one
    model rather than a benchmark, and against a framework preamble measured at a ceiling of 84 ms taken from
    the worst turn of 33 generations on that same day with a range starting at zero, a single-digit-millisecond
    local hop is not worth manufacturing a problem around. That local hop is itself unmeasured and is recorded
    as an open item in section 09.</p>

    <p class="lede-sm">Nothing in the protocol envelope is violated either. The reference publishes no deadline
    for the first text frame after a prompt and no time-to-first-token target, and its own example shows three
    token frames with the final flag on the third, so per-token sending is explicitly sanctioned.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The terms that do matter are two delivery mechanisms, not network physics</p>
      <ul>
        <li><strong>Windmill's tokens reach a client only through a database poll ladder</strong> at 100 ms for
        ten polls, 500 ms to poll one hundred, then 3 s. The knob that would tighten it is behind the
        enterprise compile flag, which the vendor's own community image also excludes. Tokens therefore arrive
        in roughly 500 ms clumps after the first second.</li>
        <li><strong>Sim's live text is speculative and can be retracted after it has been spoken.</strong> A
        turn that resolves to tool calls is reset, meaning discard what you accumulated, and synthesised audio
        cannot be unspoken.</li>
        <li>Neither of those is latency in the network sense. Both are the delivery mechanism refusing to be a
        token stream.</li>
        <li>The third term is the builder's own pre-model work, which is undocumented and unmeasured for every
        candidate on this list. That is the number a spike has to produce, and section 07 puts it in the
        order.</li>
      </ul>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Two hard constraints bind shape (b) regardless of candidate, both read from the shipped bundle</p>
      <p>The WebSocket connection handler requires a live local socket in a private map, and sessions are
      instance-local maps with no shared store, so <b>the model can be remote but session truth cannot</b>. A
      second process can generate tokens; it cannot own the conversation.</p>
      <p>And turns are serialised. The prompt dispatcher chains each turn's handler behind the previous turn's
      promise, so turn N+1's memory recall and prompt callback cannot start until turn N's handler resolves.
      <b class="warn">That head-of-line property is exactly where an added network hop lands</b>, and it is the
      single most important thing to know before adding one.</p>
    </div>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">On abort, the code is friendlier than the design assumed</p>
      <p>The streaming method breaks its loop on an aborted signal, and it resolves that signal as the caller's
      option first and its own active task second. The interrupt handler cancels the task and sends the final
      frame itself when tokens have already gone out. So the local handler does return on barge-in even with no
      abort wiring at all. What an unforwarded abort costs is upstream billing and a runaway generation, not a
      stuck queue.</p>
      <p>One related correction, because it changes where a cost sits: the SDK awaits memory retrieval before
      the prompt callback fires, so that recall is serial and upstream of anything the handler controls. It is
      not inside the 84 ms preamble, and no bridge design can move it.</p>
    </div>
  </section>
