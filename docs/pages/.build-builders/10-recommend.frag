  <!-- ============ 07 THE RECOMMENDATION ============ -->
  <section id="recommendation">
    <h2><span class="num">07</span> <b>The recommendation</b> &middot; one primary, one runner-up, and a third position for two channels</h2>

    <div class="legend">
      <span><i style="background:var(--obs)"></i> Primary</span>
      <span><i style="background:var(--plat)"></i> Runner-up</span>
      <span><i style="background:var(--neutral)"></i> Third position, non-voice</span>
      <span><i style="background:var(--app)"></i> Demoted on a mechanism the first pass did not check</span>
    </div>

    <p class="lede-sm">The recommendation is not the one the first pass produced. Its primary and its runner-up
    are both out, each on a mechanism nobody had looked for, and both are stated here rather than quietly
    dropped.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Langflow is out, because it drops the spans the scaffold exists to demonstrate</p>
      <p>Its own source says the instrumentor spans carry prompt and completion text and must never reach an
      operator's monitoring system, and that the export allowlist only ever subtracts, because a setting able to
      add a scope would reopen the leak the allowlist exists to close. Adopting it as the model runtime means the
      per-turn generation spans cannot be reconstructed from either side: not from Langflow, which drops them at
      export and forbids widening the filter, and not from a bridge, which never sees the model call and cannot
      invent token counts, cache behaviour or the model's own first-chunk instant. What arrives in the joined
      trace is one flow-execution span wrapped in HTTP and database spans. <b class="warn">For a scaffold whose
      purpose is per-turn tracing, that is close to disqualifying.</b> Its second problem is that
      browser-authored Python is executed in the server process and cannot be sandboxed, because the sandbox
      module is imported only by the two interactive-interpreter components.</p>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Sim is out for voice, on a mechanism nobody had looked for</p>
      <p>Its live text is speculative. Because a provider reveals its stop reason only at turn end, text streamed
      during a turn may turn out to have been preamble before a tool call, and Sim then sends a reset frame
      meaning discard everything accumulated for this block because the final turn will re-stream.
      <b class="warn">Synthesised audio cannot be unspoken.</b> So on a tool-calling turn the caller hears a
      preamble and then hears the real answer, with no way to retract the first. The three ways out all cost the
      thing the streaming header bought: accept occasional double-speak, drop the header and receive the whole
      final turn in one frame, or buffer until the turn is classified and reintroduce the latency. Its second
      problem is licence shape: the proprietary tree is imported at boot and on every tool call, the vendor's own
      README in that tree says the directory is required at build time, and its grant covers non-production use
      only.</p>
    </div>

    <div class="card node-detail" style="--acc:var(--obs);margin:22px 0 14px">
      <h4>Primary: Mastra, in shape (a), with requirement 3 explicitly bending</h4>
      <span class="api">in process, no transport, and the trace stays whole</span>
      <dl>
        <dt>Why it wins</dt>
        <dd>It is the only candidate that satisfies requirement 2 at the exact shape of the seam with no
        transport at all, because <code>agent.stream()</code> returns a
        <code>ReadableStream&lt;string&gt;</code> that the voice channel's method already consumes.</dd>
        <dt>The trace</dt>
        <dd>It is the only candidate that keeps the trace whole for free <em>and</em> replaces the vanished
        instrument rather than deleting it. Its bridge parents spans under the ambient context in process, and
        its exporter emits current GenAI conventions including input and output messages, system instructions,
        tool definitions, and cache read and creation token counts.</dd>
        <dt>The prefix</dt>
        <dd>Its prompt prefix is stable by design, with cache preservation stated as a goal, and the two
        documented ways to break it are the two traps this scaffold already fell into, each with a documented
        fix.</dd>
        <dt>Versioning</dt>
        <dd>Its Editor versions the prompt and the tool selection as one snapshot, with draft, publish,
        restore-into-draft, per-request version selection with no redeploy, and deterministic JSON on disk for
        pull-request review. That is a strict superset of what the scaffold has today, since the incumbent
        versions the prompt but not the tool set.</dd>
        <dt>What fails</dt>
        <dd>Requirement 3, on the vendor's own words, that collaborators choose from the tools available to the
        Editor but cannot implement new tools in Studio. That was verified against the API rather than accepted
        from prose: the server exposes list, read and execute routes for tools and no create route, and the
        enterprise Agent Builder's tool field is an allowlist of ids matched against registered tools at request
        time. Its code mode has the model write TypeScript at inference time, and its scaffolding agent writes
        TypeScript into a repository that then needs review and a restart. <b class="warn">None of those is
        builder-authored tool implementation, and none of them should be stretched into a pass.</b></dd>
      </dl>
      <p class="when">Section 04's second option is how requirement 3 gets partially met anyway</p>
    </div>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">Four conditions attach to the primary recommendation</p>
      <ul>
        <li>The console must sit behind authentication, on a path separate from any public demonstration
        surface, because the surface that edits prompts is also the surface that decides what the agent may
        do.</li>
        <li>The enterprise Agent Builder must not be deployed without an agreement. Note that the licence check
        fails open when its validation endpoint is unreachable, which makes this a compliance question rather
        than a technical gate.</li>
        <li>Orchestrate the turn as an agent and not as a workflow, because workflow streams carry lifecycle
        events rather than token text.</li>
        <li>Pin versions tightly. Minor releases land weekly on a 1.x line, the repository carries compatibility
        shims for older core versions, and the Editor, the piece this recommendation leans on hardest, ships on
        an alpha version string.</li>
      </ul>
    </div>

    <div class="card node-detail" style="--acc:var(--plat);margin:22px 0 14px">
      <h4>Runner-up: Windmill, in shape (b), and it wins when requirement 3 cannot bend</h4>
      <span class="api">out of process, the strongest authoring story, and a cadence problem behind a paid gate</span>
      <dl>
        <dt>Why it is the runner-up</dt>
        <dd>Four reasons survived verification. Its in-builder tool authoring is the strongest in the field, with
        a tool's source living in the flow value, written in the flow editor, and running as a real job under the
        normal language executor. Its prompt prefix is byte-stable by explicit design, with a source comment
        reasoning about provider cache keys. Its inline path versions the prompt, the tool selection and each
        tool's source code as one flow artifact, with an Apache-2.0 flow specification and command-line
        extraction that round-trips tool code to a reviewable tree, so a prompt change and a tool-code change
        land in one commit. And the agent step, its tool loop, its streaming events and its memory carry no
        enterprise gate at all.</dd>
        <dt>The condition</dt>
        <dd>Requirement 3 must be genuinely immovable, and one of two things must happen: either upstream
        replaces the poll loop with a push transport or ungates the settable poll delay, or the enterprise
        licence is bought, which resolves requirement 1's paid-gate failure and requirement 2's cadence together
        and also restores OTLP export.</dd>
        <dt>Without one of those</dt>
        <dd>Tokens arrive in roughly 500 ms clumps after the first second, only the terminal flow step streams,
        streams end at 60 s so reconnect and resume become this side's code, and
        <b class="warn">the per-generation attribute disappears with nothing to replace it</b>, because the string
        <code>gen_ai</code> appears nowhere in the backend.</dd>
        <dt>If adopted</dt>
        <dd>Use inline agents rather than reusable ones, because a reusable agent resource resolves live rather
        than pinned, so a run is not a snapshot. And pass this side's history through the manual-messages mode,
        to keep exactly one transcript.</dd>
      </dl>
      <p class="when">Requirement 3 satisfied in full, at the cost of the trace and the token cadence</p>
    </div>

    <div class="card node-detail" style="--acc:var(--neutral);margin:22px 0 14px">
      <h4>Third position: Sim, for the messaging and browser channels</h4>
      <span class="api">created by section 05, and worth naming rather than discovering later</span>
      <dl>
        <dt>When it applies</dt>
        <dd>If voice is out of scope, or if the messaging and browser channels are cut over first, Sim becomes
        the best answer of the twelve.</dd>
        <dt>Why the disqualifier stops applying</dt>
        <dd>Requirement 2 does not apply where the callback returns one finished string, and the reset frame is
        harmless when a final reply is assembled before sending. The mechanism that rules Sim out for speech is
        inert on a channel that sends one frame per turn.</dd>
        <dt>What it brings</dt>
        <dd>Its deployment snapshot is the best versioning surface of the twelve, its tool authoring covers both
        halves in core rather than in the proprietary tree, and it emits GenAI span names with no payloads by
        design.</dd>
        <dt>What still applies</dt>
        <dd>Requirements 1 and 3 apply on every channel, so the mixed-licence running artifact is still a
        question for counsel, and the fetch-only isolate still bounds what a browser-authored tool can do.</dd>
      </dl>
      <p class="when">A real option for two of three channels</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">What a spike must
    prove, in the order that kills candidates fastest</h3>

    <p class="lede-sm">Each step is one query rather than an investigation, which is the point of doing them in
    this order.</p>

    <div class="callout" style="--acc:var(--obs)">
      <ul>
        <li>First, count the distinct trace identifiers belonging to one call. One means the trace is whole, two
        means it is not, whatever the documentation says.</li>
        <li>Then check that the parent span identifier of the builder's topmost span equals the span identifier
        of the turn span, because a shared trace identifier with a missing parent renders as a separate
        root.</li>
        <li>Then search every span in the tree for a time-to-first-chunk attribute under both spellings, the
        metric-style name the model SDK emits and the span-style name the conventions define, and for any token
        usage attribute at all. <b>A null answer here is the finding.</b></li>
        <li>Then compare cached input token counts on the first turn against a later turn in the same
        conversation, which catches the failure no header can fix.</li>
        <li>Then measure the interval from the request write to the first non-empty text delta, minus the model's
        own time to first chunk measured separately from the same host, and report it as a distribution over
        roughly thirty turns rather than as a mean.</li>
        <li>Then confirm that a barge-in stops the builder's upstream generation, verified from the builder's own
        logs rather than from the local loop exiting.</li>
        <li>Finally, confirm that a tool authored entirely in the builder can call the platform-tool surface and
        return a result the model uses.</li>
        <li>Compare against the 586 ms to 801 ms tool-free baseline and the 84 ms preamble ceiling, both from one
        day with one caller and one model, and <b class="warn">never against the one call that landed inside a
        measured two-hour upstream slow window</b>, where a tool-free turn took multiple seconds. Those numbers
        describe the provider that afternoon and nothing about this architecture.</li>
      </ul>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Migration cost, in
    files and phases</h3>

    <p class="lede-sm">The agent core is sixteen TypeScript modules. The channel adapter is seven, and none of
    those seven moves in any shape, because the WebSocket must terminate here.</p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:800px">
        <thead>
          <tr><th>Phase</th><th>What it does, and what it proves</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>One, a bench-only spike with no Twilio</td>
            <td>Stand the builder up behind the existing model port and drive three turns through the browser
            bench. This proves the streaming shape and the prefix stability without spending anything.</td>
          </tr>
          <tr>
            <td>Two, both runtimes behind a flag</td>
            <td>The prompt version selects which runtime serves a turn, so voice can be cut over one conversation
            at a time and reverted by moving a label.</td>
          </tr>
          <tr>
            <td>Three, business tools move</td>
            <td>The business tools move into the builder and the three platform adapters are left untouched,
            which is section 04's second option in practice.</td>
          </tr>
          <tr>
            <td>Four, retire the hand-written loop</td>
            <td>Rewrite the two vendor rules that no longer describe anything, adjusting the tripwire's minimum
            count deliberately rather than lowering it to make a test pass.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="lede-sm">Phases one and two are where the decision actually gets made. <b>Phases three and four
    are only worth starting once the spike returns one trace identifier and a stable prefix.</b></p>
  </section>
