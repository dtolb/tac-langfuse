  <!-- ============ 01 THE TWELVE CANDIDATES ============ -->
  <section id="candidates">
    <h2><span class="num">01</span> <b>The twelve candidates</b> &middot; read at source, with the mechanism behind every verdict</h2>

    <p class="lede-sm">The two tables below are the scannable answer, one row per candidate, and the panels
    beneath them carry the detail each verdict rests on. A cell that reports a defect names the mechanism,
    because a capability claim with no mechanism behind it cannot be argued with. <b>Cells marked unverified
    are places where source reading and published documentation ran out</b>, and they are left that way rather
    than closed with an inference.</p>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">The three requirements, and the two things that are scored rather than filtered</p>
      <ul>
        <li><strong>Requirement 1 is self-hostable open source</strong>, meaning a local container stack, no
        hosted control plane, and no paid gate over a feature the design needs. A permissive root licence with a
        proprietary tree beside it is judged by whether that tree sits on the path the design runs.</li>
        <li><strong>Requirement 2 is token-level streaming out of the runtime</strong>, because
        ConversationRelay synthesises speech from text arriving incrementally over a WebSocket, so a runtime
        that returns one finished string per turn puts the whole generation time into the caller's ear.</li>
        <li><strong>Requirement 3 is in-builder tool authoring</strong>, both halves, the definition a model
        sees and the implementation that runs, authored inside the builder. A definition-only tool that
        forwards to code you host does not satisfy it.</li>
      </ul>
      <p style="margin-top:10px">Visual authoring quality, and whether a builder can retire the separate prompt-and-tracing service,
      are scored in the second table rather than used as filters. Section 05 shows that requirement 2 is
      voice-only by construction, which is what creates a third position for the other channels.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The three
    requirements, twelve rows</h3>

    <div class="wide tablewrap">
      <table style="min-width:940px">
        <thead>
          <tr><th>Candidate</th><th>1 &middot; Self-hosted open source</th><th>2 &middot; Token streaming</th><th>3 &middot; In-builder tools</th><th>Position</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Mastra</td>
            <td>Pass on the runtime path. Apache core, proprietary trees away from streaming and tools</td>
            <td>Pass, at the exact shape of the seam, with two open tool-event buffering defects</td>
            <td><b class="warn">Fail</b>, on the vendor's own words and confirmed against the API</td>
            <td>Primary, in process, with requirement 3 bending</td>
          </tr>
          <tr>
            <td>Windmill</td>
            <td><b class="warn">Fail</b>. The knob that fixes cadence is behind a compile flag the community image excludes</td>
            <td><b class="warn">Fail</b> at the network boundary. Correct inside the worker, then delivered by a database poll ladder</td>
            <td>Pass, the strongest in the field</td>
            <td>Runner-up, only when requirement 3 cannot bend</td>
          </tr>
          <tr>
            <td>Sim</td>
            <td>Pass technically, with a mixed-licence running artifact</td>
            <td><b class="warn">Fail for voice.</b> Live text is speculative and can be retracted after it has been spoken</td>
            <td>Pass, with a runtime narrower than its own docs claim</td>
            <td>Third position, the non-voice channels only</td>
          </tr>
          <tr>
            <td>Langflow</td>
            <td>Pass. Plain MIT, the cleanest licence of the visual builders</td>
            <td>Pass, once the bridge writes its own frame splitter</td>
            <td>Pass, and unsandboxed in the server process</td>
            <td>Rejected. It drops the generation spans by design</td>
          </tr>
          <tr>
            <td>Coze Studio</td>
            <td>Pass. Verbatim Apache, no licence-key check</td>
            <td>Pass, proven from the backend rather than inferred</td>
            <td>Partial. Real code authoring, Python only, and network-less by default</td>
            <td>Rejected. A cold prompt cache on every turn, and no tracing</td>
          </tr>
          <tr>
            <td>Node-RED</td>
            <td>Pass. Apache, no gate anywhere in core</td>
            <td>Pass only through one third-party node by one maintainer</td>
            <td>Partial. Real implementations, no tool-definition mechanism at all</td>
            <td>Rejected. The best in-process shape, and not an agent builder</td>
          </tr>
          <tr>
            <td>VoltAgent</td>
            <td>Pass for the library. The paid gate is the separate hosted console</td>
            <td>Pass for a single agent. Sub-agent text is structurally absent</td>
            <td><b class="warn">Fail.</b> No route creates an agent, a prompt or a tool</td>
            <td>Rejected. No authoring surface to move authoring to</td>
          </tr>
          <tr>
            <td>Dify</td>
            <td><b class="warn">Fail.</b> Modified Apache, not OSI approved, and a required component ships only as a prebuilt image</td>
            <td>Partial. The reasoning-loop runner emits the whole final answer as one chunk</td>
            <td>Partial. Only the code node authors an implementation</td>
            <td>Rejected on licence, which is the sharper loss because its tracing is the best out of process</td>
          </tr>
          <tr>
            <td>Flowise</td>
            <td><b class="warn">Fail.</b> The carve-out is not confined to an optional wing and the entry point imports it at boot</td>
            <td>Pass only when the agent node is last in the flow</td>
            <td>Pass, in a sandboxed VM</td>
            <td>Rejected. No versioning of any kind</td>
          </tr>
          <tr>
            <td>Rivet</td>
            <td>Pass. Clean MIT, no enterprise tier</td>
            <td><b class="warn">Fail.</b> Deltas are coalesced on a timer and the cursor is never reset</td>
            <td>Pass, unsandboxed by default</td>
            <td>Rejected. Dormant for roughly fifteen months</td>
          </tr>
          <tr>
            <td>LangGraph JS with Studio</td>
            <td><b class="warn">Fail on Studio.</b> No source repository, no package, and a hosted account is a documented prerequisite</td>
            <td>Pass on three transports, with two open defects through the tool loop</td>
            <td><b class="warn">Fail.</b> Studio has no code editor and no execution runtime</td>
            <td>Rejected. The builder half is the hosted platform</td>
          </tr>
          <tr>
            <td>Letta Code</td>
            <td>Pass, with several advertised features cloud-gated in code</td>
            <td>Partial. Text streams; tool calls and reasoning are invisible and the socket is silent through the tool interval</td>
            <td><b class="warn">Fail.</b> Mods are files on the harness machine</td>
            <td>Rejected. A CLI harness, not a builder</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Integration shape,
    versioning and observability</h3>

    <p class="lede-sm">These four columns decide the cost of adoption rather than eligibility. The in-process
    column is the one that quietly settles the trace question, because a library called inside the existing
    turn span has nothing to stitch.</p>

    <div class="wide tablewrap">
      <table style="min-width:1000px">
        <thead>
          <tr><th>Candidate</th><th>In process in Node</th><th>Accepts a W3C <code>traceparent</code></th><th>Prompt and tool-selection versioning</th><th>OTLP export</th><th>Visual authoring</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Mastra</td>
            <td>Yes, its primary shape</td>
            <td>Yes in process, parented under the ambient context. No inbound extraction over HTTP anywhere in its code</td>
            <td>Yes, and together, as one Editor version with draft, publish and restore</td>
            <td>Yes, native, current GenAI conventions including cache read and creation tokens</td>
            <td>Strong on prompts, real but bounded on tools. The Editor ships on an alpha version string</td>
          </tr>
          <tr>
            <td>Windmill</td>
            <td>No. A Rust workspace with no library entry point</td>
            <td>Only at job push, gated on a variable, and never on the streaming endpoint</td>
            <td>Yes, and best-in-class on the inline path: prompt, model, tool roster and each tool's source as one artifact</td>
            <td><b class="warn">No</b> from public source. Zero occurrences of <code>gen_ai</code> in the backend</td>
            <td>A developer-facing flow editor, not a canvas for a non-engineer</td>
          </tr>
          <tr>
            <td>Sim</td>
            <td>No. A Next.js application reachable over HTTP</td>
            <td>No. Only the trace id is extracted, into a log context</td>
            <td>Yes, the best control surface of the field. Deploying snapshots the whole canvas</td>
            <td>Yes, with GenAI span names and no payloads by design</td>
            <td>Strong. Canvas, per-block model selection, tool authoring in the same interface</td>
          </tr>
          <tr>
            <td>Langflow</td>
            <td>No. A Python service</td>
            <td>Yes. The web framework is instrumented, so the header parents the server span</td>
            <td>An activate route exists in the MIT tree, registered out of the schema and in no published doc</td>
            <td>Yes, and deliberately not LLM tracing. All three signals deny by default</td>
            <td>Good canvas with an in-browser code editor</td>
          </tr>
          <tr>
            <td>Coze Studio</td>
            <td>No. A compiled Go monolith published as images</td>
            <td>No. Zero occurrences anywhere in the repository</td>
            <td>One atomic published snapshot, with no version field on the public chat request</td>
            <td>None. The two trace read handlers return an empty struct with HTTP 200</td>
            <td>Best of the field, and the best visual authoring verified anywhere in this sweep</td>
          </tr>
          <tr>
            <td>Node-RED</td>
            <td>Yes, and the best structural fit. The documented embed surface mounts on an existing app</td>
            <td>No span model to continue a trace into. The header does reach flow code</td>
            <td>Atomic, because prompt and tool wiring are one flow document. The git-backed feature is off by default</td>
            <td>None. No exporter, no span model, no GenAI attributes</td>
            <td>Best-in-class canvas, with nothing LLM-shaped in it</td>
          </tr>
          <tr>
            <td>VoltAgent</td>
            <td>Yes. A thin layer over the same model SDK the scaffold already calls</td>
            <td>In process yes, through an explicit parent-span option. Over HTTP it severs the ambient parent deliberately</td>
            <td>Prompt versions, labels and diff live in the hosted console. Tool selection is never versioned with a prompt</td>
            <td>Accepts span processors, so any exporter works, but emits no <code>gen_ai</code> attributes at all</td>
            <td>Weak for this purpose. It cannot edit agents, tool code, tool schemas or tool selection</td>
          </tr>
          <tr>
            <td>Dify</td>
            <td>No. A Python service</td>
            <td>Yes, and best of the out-of-process candidates. Composite propagator, instrumented framework, parent-based sampler</td>
            <td>Yes, ungated: publish, list versions, restore to draft, version history</td>
            <td>Yes in the community build. The richer exporter is edition-gated</td>
            <td>Strong canvas, mature</td>
          </tr>
          <tr>
            <td>Flowise</td>
            <td>No. A Node service with no library seam</td>
            <td>No match in the repository, which is strong rather than conclusive</td>
            <td><b class="warn">None.</b> No version column, no history table, and saving overwrites in place</td>
            <td>Unverified. Analytics integrations exist and no OTLP path was established</td>
            <td>Strong canvas, the best known of the field</td>
          </tr>
          <tr>
            <td>Rivet</td>
            <td>Yes, and uniquely cleanly, with a partial-output listener and no transport at all</td>
            <td>Not applicable in the shape worth using, and it contributes no spans either way</td>
            <td>Graphs are files, versioned by git, prompt text inline. No activate operation and no label</td>
            <td>None. Zero matches in the bundle</td>
            <td>A desktop development environment, engineer-facing</td>
          </tr>
          <tr>
            <td>LangGraph JS with Studio</td>
            <td>Yes. The graph stream in messages mode is an in-process async generator</td>
            <td>No. Propagation uses the vendor's own headers and links into its run tree, not an OTel trace</td>
            <td>Assistants and versions exist, largely as a platform story, and adopting them means running the server tier</td>
            <td>Unverified for this shape</td>
            <td>Centred on the hosted platform</td>
          </tr>
          <tr>
            <td>Letta Code</td>
            <td>No, and worse: the extension mechanism is the harness, so a service driving it over the API gets nothing</td>
            <td>No match in the repository, and no OpenTelemetry dependency in its packaging metadata</td>
            <td>Memory blocks in a real per-agent git repository with a content hash per compiled prompt, rewritten by the agent itself</td>
            <td>Unverified</td>
            <td>None. This is a command-line and desktop harness</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Every candidate,
    and the mechanism behind its verdict</h3>

    <p class="lede-sm">One panel per candidate, in the order the tables use, which is the order the
    recommendation lands in rather than alphabetical. The three panels carrying a coloured rule are the three
    positions argued in section 07.</p>
    <div class="card node-detail" style="--acc:var(--obs);margin-bottom:14px">
      <h4>Mastra</h4>
      <span class="api">primary recommendation &middot; in process, with requirement 3 bending</span>
      <dl>
        <dt>Licence</dt>
        <dd>Apache-2.0 core with a proprietary Enterprise Edition licence over every <code>ee/</code>
        directory, which is why
        <a href="https://github.com/mastra-ai/mastra">GitHub reports NOASSERTION</a>. Seven <code>ee/</code>
        trees exist, and two of them are the Studio trace-analysis interface that the playground app imports
        statically, so Studio is not wholly Apache. The runtime, streaming, tools, memory, exporters and the
        non-enterprise Editor carry no licence check. Enterprise production use requires a written agreement,
        and the licence client validates against a hosted endpoint only if a key is set.</dd>
        <dt>Streaming</dt>
        <dd>Yes, in process, at the exact shape of the seam: <code>agent.stream()</code> returns a
        <code>ReadableStream&lt;string&gt;</code> of text-delta payloads. Two open, assigned defects buffer
        tool events by default. Tool results are held behind a barrier until the last execution in a step
        finishes, and a tool cannot start executing until the model step consumes its finish event. Text
        itself is unbuffered; tool-result emission is not.</dd>
        <dt>In-builder tools</dt>
        <dd><b class="warn">No, and the docs say it outright</b>, that collaborators choose from the tools
        available to the Editor and cannot implement new ones in Studio. Verified against the API rather than
        accepted from prose: the server exposes list, read and execute routes for tools and no create route.
        The enterprise Agent Builder adds an allowlist of tool ids matched against code-registered tools at
        request time, which is a filter rather than authoring.</dd>
        <dt>In process</dt>
        <dd>Yes, and this is its primary shape. The core package is a library, and the HTTP server exists to
        serve the console.</dd>
        <dt>traceparent</dt>
        <dd>Yes in process, which is the configuration that matters, because the bridge parents its spans
        under the ambient OpenTelemetry context. Over HTTP there is no inbound extraction anywhere in its
        code, so an HTTP boundary needs standard OpenTelemetry HTTP instrumentation added by the host.</dd>
        <dt>Versioning</dt>
        <dd>Yes, and both together. The docs state that the Editor stores tool selections as part of an agent
        version, with draft, publish, restore-into-draft, per-request version selection with no redeploy, and
        deterministic JSON on disk for pull-request review. That is a strict superset of what the scaffold has
        today, which versions the prompt but not the tool set.</dd>
        <dt>OTLP</dt>
        <dd>Yes, native, with current GenAI semantic conventions including input and output messages, system
        instructions, tool definitions, and cache read and creation token counts. A first-party exporter for
        the incumbent trace store also ships.</dd>
        <dt>Visual</dt>
        <dd>Strong on prompts, real but bounded on tools. Prompt blocks are reusable and publishable. The
        Editor package, the piece the recommendation leans on hardest, ships on an alpha version string.</dd>
      </dl>
      <p class="when">Requirement 1 pass on the runtime path, 2 pass, 3 fail</p>
    </div>

    <div class="card node-detail" style="--acc:var(--plat);margin-bottom:14px">
      <h4>Windmill</h4>
      <span class="api">runner-up &middot; out of process, and only when requirement 3 cannot bend</span>
      <dl>
        <dt>Licence</dt>
        <dd>AGPL-3.0 backend and frontend, Apache-2.0 clients and flow specification, plus proprietary code
        behind an enterprise compile flag, which is why
        <a href="https://github.com/windmill-labs/windmill">GitHub reports NOASSERTION</a>. The published
        community image is built with a feature set that links closed modules whose sources are absent from
        the repository, so the running artifact is not auditable from public source. The community grant
        forbids reselling, serving as a managed service, or wrapping without agreement.</dd>
        <dt>Streaming</dt>
        <dd><b class="warn">No, at the network boundary.</b> Inside the worker it is exactly right: one
        token-delta event per provider chunk, interleaved with tool-call and tool-result events on one ordered
        sink. Then every event is written as its own database row, and the only reader is a poll loop at 100 ms
        for ten polls, 500 ms to poll one hundred, then 3 s. The fix, a settable poll delay clamped to a 50 ms
        floor, is behind the enterprise compile flag, and the published community image is on the gated side
        of it. Only the flow's terminal step streams, and streams end at 60 s.</dd>
        <dt>In-builder tools</dt>
        <dd>Yes, the strongest in the field. An inline tool's source lives in the flow value, is written in the
        flow editor, and runs as its own job under the normal language executor across many languages.
        Browser-authored code runs unsandboxed by default, because the isolation flag defaults to
        disabled.</dd>
        <dt>In process</dt>
        <dd>No. A large Rust workspace requiring its own database, with no library entry point. The published
        npm package is an HTTP and server-sent-events client.</dd>
        <dt>traceparent</dt>
        <dd>Only at job push, gated on a tracing environment variable, and never on the streaming endpoint.
        With the tracer stubbed and the parenting function empty, nothing continues the trace. The value does
        reach tool code as an environment variable, so a hand-rolled join is possible.</dd>
        <dt>Versioning</dt>
        <dd>Yes, and best-in-class on the inline path: prompt, model, tool roster and each inline tool's source
        version as one flow artifact, with an Apache-2.0 flow specification and command-line extraction that
        round-trips tool code to reviewable files, so a prompt change and a tool-code change land in one
        commit. The reusable-agent resource path resolves live rather than pinned, which is a hazard rather
        than an improvement.</dd>
        <dt>OTLP</dt>
        <dd>No, from public source. The initialiser returns none unconditionally, the working module is absent
        from the repository, and the feature belongs to the enterprise set. Zero occurrences of
        <code>gen_ai</code> anywhere in the backend.</dd>
        <dt>Visual</dt>
        <dd>A developer-facing flow editor with schema-aware input binding and a prompt form. It is not a
        canvas for a non-engineer.</dd>
      </dl>
      <p class="when">Requirement 1 fail on a paid gate over a needed feature, 2 fail, 3 pass</p>
    </div>

    <div class="card node-detail" style="--acc:var(--neutral);margin-bottom:14px">
      <h4>Sim</h4>
      <span class="api">third position &middot; the best answer for the messaging and browser channels</span>
      <dl>
        <dt>Licence</dt>
        <dd>Root Apache-2.0, plus a proprietary enterprise licence over one application subtree whose grant
        covers development, testing, evaluation and internal non-production use only. That tree is not
        excisable: the vendor's own README inside it says enterprise features are imported directly throughout
        the codebase and the directory is required at build time. Enterprise code runs at boot and on every
        tool call.</dd>
        <dt>Streaming</dt>
        <dd>Mechanically yes, and unusable for speech as designed. With the protocol header set, one chunk
        frame arrives per model delta including mid-turn. But live text is speculative: a turn that resolves to
        tool calls is retracted with a reset frame meaning discard what you accumulated.
        <b class="warn">Synthesised audio cannot be unspoken</b>, so a tool-calling turn speaks a preamble and
        then speaks the real answer.</dd>
        <dt>In-builder tools</dt>
        <dd>Yes, both halves, and in core rather than enterprise: a function schema in one editor and a
        JavaScript body in another, with secrets bound at execution time. The runtime is narrower than its own
        docs claim. A pinning test asserts the isolate provides plain ECMAScript plus <code>fetch</code>, with
        no buffer or crypto module and not even a timer function, and custom tools are hardcoded off the
        remote-sandbox path.</dd>
        <dt>In process</dt>
        <dd>No. A Next.js application reachable only over HTTP; the published SDKs are clients.</dd>
        <dt>traceparent</dt>
        <dd>No. The route wrapper extracts only the thirty-two hexadecimal characters of the trace id into a
        log context so lines can be grepped. Workflow spans are additionally created after the run completes
        with backdated start times, so there is nothing live to parent.</dd>
        <dt>Versioning</dt>
        <dd>Yes, and the best control surface of the field. Deploying snapshots the whole canvas as a numbered
        version, so prompt, model, parameters and tool selection version as one unit, with promote-to-live as
        the documented instant rollback. Git tracking means committing an exported JSON graph; there is no
        text-first definition language.</dd>
        <dt>OTLP</dt>
        <dd>Yes, with GenAI span names and token and cost attributes, and no prompts, completions, tool
        arguments or tool results by design. An export allowlist additionally drops the workflow executor's
        own spans.</dd>
        <dt>Visual</dt>
        <dd>Strong. Canvas, per-block model selection, tool authoring in the same interface, and live tool and
        thinking chips on the draft run.</dd>
      </dl>
      <p class="when">Requirement 1 pass technically with a mixed-licence running artifact, 2 fail for voice, 3 pass with a fetch-only runtime</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Langflow</h4>
      <span class="api">rejected &middot; it drops the spans the scaffold exists to demonstrate</span>
      <dl>
        <dt>Licence</dt>
        <dd>Plain MIT, one
        <a href="https://github.com/langflow-ai/langflow/blob/main/LICENSE">licence file</a>, and no
        enterprise carve-out near any needed path. The cleanest licence of the visual builders.</dd>
        <dt>Streaming</dt>
        <dd>Yes, confirmed in source. The agent component hardcodes streaming and documents that the interface
        toggle is deliberately ignored, and the event loop dispatches tool handlers and the token handler in
        the same iteration. The run endpoint labels itself as an event stream and emits bare
        newline-delimited JSON with no event-field prefix, so a conforming parser reads nothing and the bridge
        has to write its own splitter.</dd>
        <dt>In-builder tools</dt>
        <dd>Yes. Browser-authored custom-component Python is compiled and executed by the server. It is not
        sandboxed and cannot be: the sandbox module is imported only by the two interactive-interpreter
        components, so the sandbox backend setting buys nothing for custom components. The controls are two
        settings that default to permissive.</dd>
        <dt>In process</dt>
        <dd>No. A Python service.</dd>
        <dt>traceparent</dt>
        <dd>Yes. The web framework is instrumented, so the inbound header parents the server span and the flow
        span below it.</dd>
        <dt>Versioning</dt>
        <dd>Present in the MIT tree with a real activate route, but the router is registered out of the schema
        and appears in no published document, so it is an internal API. The prompt is a field inside a flow
        document rather than an addressable object.</dd>
        <dt>OTLP</dt>
        <dd>Yes, and deliberately not LLM tracing. Its own source states that all three signals deny by
        default on export, that the allowlist admits four scopes, that instrumentor spans carry prompt and
        completion text and must never reach an operator's monitoring system, and that the allowlist only ever
        subtracts. About one flow-execution span per run reaches the collector.</dd>
        <dt>Visual</dt>
        <dd>Good canvas with an in-browser code editor.</dd>
      </dl>
      <p class="when">Requirement 1 pass, 2 pass with a custom splitter, 3 pass and unsandboxed</p>
    </div>
    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Coze Studio</h4>
      <span class="api">rejected &middot; passes all three requirements and should still not be adopted</span>
      <dl>
        <dt>Licence</dt>
        <dd>Verbatim Apache-2.0 with no added clauses, in the
        <a href="https://github.com/coze-dev/coze-studio">public repository</a>, with no enterprise directory
        and no licence-key check. One qualification: the backend carries a live entitlement client that calls
        the vendor's hosted API by default to read an account tier and marketplace plugin quotas.</dd>
        <dt>Streaming</dt>
        <dd>Yes, and proven from the backend rather than inferred. The producer assigns the fragment rather
        than an accumulating buffer, and the transport layer flushes per event. Deltas keep flowing through a
        tool-calling turn, with silence for exactly the tool's own latency. Reasoning deltas arrive on the same
        stream sharing the answer message id, <b class="warn">so a naive consumer speaks the model's chain of
        thought</b>.</dd>
        <dt>In-builder tools</dt>
        <dd>Partial. Plugins are definition-only, storing an OpenAPI operation and forwarding to a server you
        run. The workflow code node is real authoring, but it is Python only, and the default sandbox grants no
        network permission out of the box, so a tool that must call a service still needs a definition-only
        plugin pointing at code you host.</dd>
        <dt>In process</dt>
        <dd>No. A compiled Go monolith published as images.</dd>
        <dt>traceparent</dt>
        <dd>No. Zero occurrences of the string anywhere in the repository, and no spans for it to parent.</dd>
        <dt>Versioning</dt>
        <dd>Prompt and tool selection are one atomic published snapshot, which is the right idea. But the
        public chat request has no version field, so it always gets the most recent publish; there is no
        activate operation, no diff and no flow export.</dd>
        <dt>OTLP</dt>
        <dd>None. All OpenTelemetry modules are indirect dependencies, and the two trace read handlers bind
        their request and return an empty struct with HTTP 200, so the trace panel in the interface is wired to
        endpoints that return nothing.</dd>
        <dt>Visual</dt>
        <dd>Best of the field, and the best visual authoring verified anywhere in this sweep, which is exactly
        what makes the rest easy to overlook.</dd>
      </dl>
      <p class="when">Requirement 1 pass, 2 pass, 3 partial and network-less by default</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Node-RED</h4>
      <span class="api">rejected &middot; the best in-process shape, and not an agent builder</span>
      <dl>
        <dt>Licence</dt>
        <dd>Apache-2.0, no gate anywhere in core, project-published images and no control plane, in the
        <a href="https://github.com/node-red/node-red">public repository</a>. The licence picture is Apache
        plus vendored permissive licences in the editor client, all harmless for internal use.</dd>
        <dt>Streaming</dt>
        <dd>Not in core at all. Core ships zero LLM nodes across thirty-seven nodes in six categories. The
        capability rests on one MIT third-party node by one maintainer, which emits each model chunk as its own
        message. Because the streaming branch returns nothing assembled, tool-argument reassembly and
        message-history accumulation are the host's code, and default message delivery to the next node is a
        macrotask hop rather than a synchronous call.</dd>
        <dt>In-builder tools</dt>
        <dd>Half. Writing an arbitrary JavaScript implementation in the browser is genuine, executed by Node's
        own virtual-machine module in the same process. <b class="warn">There is no tool-definition mechanism at
        all</b>: surfacing a name, a description and an argument schema to a model needs either a small
        third-party package or an adapter in your own source.</dd>
        <dt>In process</dt>
        <dd>Yes, and the best structural fit of the twelve. The package's documented embed surface mounts on an
        existing web application, so a chunk reaches the voice channel's consumer with no serialisation.</dd>
        <dt>traceparent</dt>
        <dd>No, and there is no span model to continue a trace into. An inbound header does reach flow code
        through the request object, so joining by hand is possible.</dd>
        <dt>Versioning</dt>
        <dd>Prompt text and tool wiring version atomically, because they are the same flow document, and the
        git-backed projects feature makes that native. That feature is off by default and enabling it on a
        plain install means editing the settings file.</dd>
        <dt>OTLP</dt>
        <dd>None. No exporter, no span model, no GenAI attributes.</dd>
        <dt>Visual</dt>
        <dd>Best-in-class canvas with one real gap: everything LLM-shaped is unopinionated, so standing up the
        orchestration is engineering on a general-purpose dataflow tool.</dd>
      </dl>
      <p class="when">Requirement 1 pass, 2 pass only through a third-party node, 3 partial</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>VoltAgent</h4>
      <span class="api">rejected &middot; a good library with no authoring surface to move authoring to</span>
      <dl>
        <dt>Licence</dt>
        <dd>MIT, one licence file, no enterprise directory and no entitlement check in the
        <a href="https://github.com/VoltAgent/voltagent">code</a>. The paid gate is a separate hosted console:
        self-hosting it is available only on the top commercial tier, and the free tier allows one prompt. Note
        that two environment variables silently construct and register a client that begins exporting
        spans.</dd>
        <dt>Streaming</dt>
        <dd>Yes for a single agent with its own tools, over the model SDK's multi-step loop. Sub-agent text is
        structurally absent from the text stream, because the merge happens only on the full stream, where a
        hardcoded allowlist excludes text deltas by default. One open defect makes a supervisor combined with
        output guardrails never emit a finish event, hanging the stream.</dd>
        <dt>In-builder tools</dt>
        <dd><b class="warn">No.</b> Tools are a schema plus an execute function in TypeScript you host, and no
        route creates an agent, a prompt or a tool. Definition-only tools are first-class, but the
        implementation then moves to a browser client or the model provider, never to a builder.</dd>
        <dt>In process</dt>
        <dd>Yes, and its strongest fit: a thin layer over the same model SDK the scaffold already calls.</dd>
        <dt>traceparent</dt>
        <dd>Over HTTP no, and worse than absent: the trace context deliberately severs any ambient parent to
        force a root span, attaching the ambient span only as a link. In process yes, through explicit
        parent-span call options.</dd>
        <dt>Versioning</dt>
        <dd>Prompt versions, labels, diff and rollback exist in the hosted console only. A file-based prompt
        path with numeric versions does ship in the MIT core. Tool selection is never versioned with a prompt;
        a version stores content plus model parameters.</dd>
        <dt>OTLP</dt>
        <dd>Accepts user-supplied span processors, so any exporter works. But it emits no <code>gen_ai</code>
        attributes at all and does not pass the model SDK's telemetry option, so the per-generation instrument
        disappears.</dd>
        <dt>Visual</dt>
        <dd>Weak for this purpose. The console can edit prompts, memory and workspace files. It cannot edit
        agents, tool code, tool schemas or which tools an agent gets, because no route exists.</dd>
      </dl>
      <p class="when">Requirement 1 pass for the library, 2 pass for single agents, 3 fail</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Dify</h4>
      <span class="api">rejected on licence &middot; and it has the best out-of-process tracing of the twelve</span>
      <dl>
        <dt>Licence</dt>
        <dd>Modified Apache-2.0; GitHub reports NOASSERTION and it is not approved by the Open Source
        Initiative. Single-workspace commercial self-hosting is permitted, while operating a multi-tenant
        environment and removing console branding are forbidden, per the
        <a href="https://github.com/langgenius/dify/blob/main/LICENSE">licence file</a>. Part of the required
        stack for the agent node ships only as a prebuilt image, so a needed component is a binary.</dd>
        <dt>Streaming</dt>
        <dd>Partial. Real server-sent events on the chat endpoint and per-delta output on the function-calling
        agent path. The reasoning-loop runner emits the whole final answer as one chunk, corroborated by a
        captured transcript in
        <a href="https://github.com/langgenius/dify/issues/27028">issue 27028</a>. Workflow agent-node chunks
        are forwarded only when an answer node's template references the selector.</dd>
        <dt>In-builder tools</dt>
        <dd>Partial. Only the code node authors an implementation in the console; OpenAPI and MCP tools are
        definition-only and forward to code you host. The sandbox is restricted, with recurring permission
        reports in <a href="https://github.com/langgenius/dify/issues/29843">issue 29843</a> and a short
        worker timeout.</dd>
        <dt>In process</dt>
        <dd>No. A Python service.</dd>
        <dt>traceparent</dt>
        <dd>Yes, and best of the out-of-process candidates. A composite propagator is installed as the global
        textmap, the web framework is instrumented, and the sampler is parent-based, so the caller's sampled
        flag is honoured.</dd>
        <dt>Versioning</dt>
        <dd>Yes, and ungated: publish, list published versions, restore to draft, and a version-history
        panel.</dd>
        <dt>OTLP</dt>
        <dd>Yes in the community build, with application and workflow spans, over standard endpoint variables.
        The richer exporter is edition-gated, so verify which spans the community build emits.</dd>
        <dt>Visual</dt>
        <dd>Strong canvas, mature.</dd>
      </dl>
      <p class="when">Requirement 1 fail, 2 partial, 3 partial</p>
    </div>
    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Flowise</h4>
      <span class="api">rejected &middot; no versioning of any kind, and an unbounded licence carve-out</span>
      <dl>
        <dt>Licence</dt>
        <dd>Apache-2.0 with a carve-out that is not confined to an optional wing. The server entry point
        imports enterprise middleware unconditionally at boot, and the carve-out extends open-endedly to files
        carrying an explicit copyright notice, per the
        <a href="https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md">licence file</a>. That is a
        question for counsel rather than a settled answer.</dd>
        <dt>Streaming</dt>
        <dd>Yes only in one configuration. Streaming requires the agent node to be last; any agent node with an
        outgoing edge sends the whole answer in one token event, and enabling post-processing turns the endpoint
        non-streaming. Frames use a non-standard field name, and
        <a href="https://github.com/FlowiseAI/Flowise/issues/5592">issue 5592</a> reports intermittently zero
        token events.</dd>
        <dt>In-builder tools</dt>
        <dd>Yes. A custom tool takes a name, a description, a JSON schema and a JavaScript body, executed in a
        sandboxed virtual machine with HTTP libraries always available. That virtual-machine library is pinned
        to an old release, which is recorded here as an open item rather than as a cited advisory.</dd>
        <dt>In process</dt>
        <dd>No. A Node service, but with no library seam.</dd>
        <dt>traceparent</dt>
        <dd>No match in the repository, which is a strong rather than conclusive negative, because a
        string search misses a capability provided entirely by a dependency.</dd>
        <dt>Versioning</dt>
        <dd><b class="warn">None.</b> The chat-flow entity has no version column and no history table, and
        saving overwrites the flow data in place, which is disqualifying for a scaffold whose headline is
        versioned prompts.</dd>
        <dt>OTLP</dt>
        <dd>Unverified. Analytics integrations exist and no OTLP path was established.</dd>
        <dt>Visual</dt>
        <dd>Strong canvas, the best known of the field.</dd>
      </dl>
      <p class="when">Requirement 1 fail, 2 pass only as a terminal node, 3 pass</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Rivet</h4>
      <span class="api">rejected &middot; the cleanest licence and the cleanest in-process shape, and it cannot stream a token</span>
      <dl>
        <dt>Licence</dt>
        <dd>Clean MIT, no enterprise tier, and everything needed in one
        <a href="https://github.com/Ironclad/rivet/blob/main/LICENSE">repository</a>.</dd>
        <dt>Streaming</dt>
        <dd><b class="warn">No.</b> The chat node throttles partial output on a timer defaulting to 100 ms, so
        deltas arrive as coalesced multi-token chunks. The delta cursor is keyed by node id and never reset, so
        a chat node re-run by a tool loop slices the second iteration against the first iteration's length, and
        text mode closes the stream at the first node-finish event.</dd>
        <dt>In-builder tools</dt>
        <dd>Yes. A code node plus tool, HTTP, MCP and subgraph nodes, with five permission toggles all
        defaulting off. The code runner is unsandboxed by default, though it is an injectable option and a
        refusing runner ships.</dd>
        <dt>In process</dt>
        <dd>Yes, and uniquely cleanly: the Node package runs a graph in process with a partial-output listener
        and no transport at all.</dd>
        <dt>traceparent</dt>
        <dd>Not applicable in the shape worth using, and it contributes no spans of its own either way.</dd>
        <dt>Versioning</dt>
        <dd>Graphs are files, versioned by git, with the prompt text inline. There is no activate operation and
        no label.</dd>
        <dt>OTLP</dt>
        <dd>None. Zero matches in the bundle.</dd>
        <dt>Visual</dt>
        <dd>A desktop development environment, engineer-facing, and it has seen no feature release in roughly
        fifteen months.</dd>
      </dl>
      <p class="when">Requirement 1 pass, 2 fail, 3 pass</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>LangGraph JS with Studio</h4>
      <span class="api">rejected &middot; the libraries are MIT and the builder half is the hosted platform</span>
      <dl>
        <dt>Licence</dt>
        <dd>The libraries and server are MIT, but Studio has no source repository and no package. Its
        development command opens a hosted URL, and the documented prerequisites are a hosted account and an API
        key. A self-hosted version of that platform is an enterprise add-on requiring a purchased key and
        egress to a vendor endpoint.</dd>
        <dt>Streaming</dt>
        <dd>Yes on three transports, with open defects through the tool loop.
        <a href="https://github.com/langchain-ai/langgraphjs/issues/1667">Issue 1667</a> has been open a year
        showing tool calls splitting into a name-only call plus an arguments-only fallback call, and
        <a href="https://github.com/langchain-ai/langgraphjs/issues/2570">issue 2570</a> reports dirty
        tool-call arguments on the partial-message mode.</dd>
        <dt>In-builder tools</dt>
        <dd><b class="warn">No.</b> Tools are TypeScript source. Studio has no code editor and no execution
        runtime, and its assistant configuration is selection; the one editable field type is a prompt. The
        hosted agent builder adds tools by connecting integrations or remote MCP servers.</dd>
        <dt>In process</dt>
        <dd>Yes. The graph stream in messages mode is an in-process async generator.</dd>
        <dt>traceparent</dt>
        <dd>No. Propagation uses the vendor's own headers carrying a dotted order and baggage, both sides must
        opt in, and the graph reads the values out of its configurable block. It links into the vendor's run
        tree, not into an OpenTelemetry trace.</dd>
        <dt>Versioning</dt>
        <dd>Assistants and versions exist, largely as a platform story, and adopting them means running the
        server tier.</dd>
        <dt>OTLP</dt>
        <dd>Unverified for this shape.</dd>
        <dt>Visual</dt>
        <dd>Centred on the hosted platform.</dd>
      </dl>
      <p class="when">Requirement 1 fail on Studio, 2 pass with defects, 3 fail</p>
    </div>

    <div class="card node-detail" style="--acc:var(--line);margin-bottom:14px">
      <h4>Letta Code</h4>
      <span class="api">rejected &middot; excellent prompt provenance, pointing the wrong way</span>
      <dl>
        <dt>Licence</dt>
        <dd>Apache-2.0 plus a brand-assets exclusion, and commercial self-hosting is permitted. Several
        advertised features are cloud-gated in code, including git sync for the memory filesystem and listener
        registration, which exits with an unsupported-self-hosted error.</dd>
        <dt>Streaming</dt>
        <dd>Partial. Text streams incrementally with a done sentinel, but the route passes only an
        assistant-text handler, so tool calls and reasoning are invisible and the socket is silent for the whole
        tool interval with no heartbeat, per
        <a href="https://github.com/letta-ai/letta-code/issues/3634">issue 3634</a>. Subagent output never
        streams.</dd>
        <dt>In-builder tools</dt>
        <dd><b class="warn">No.</b> Extensions are TypeScript files written to a directory on the machine and
        imported into the harness process. There is no builder authoring surface, and they only help if the
        agent runs inside that harness.</dd>
        <dt>In process</dt>
        <dd>No, and worse: the mechanism is the harness, so a Node service driving the agent over the API gets
        nothing from it.</dd>
        <dt>traceparent</dt>
        <dd>No match in the repository, and no OpenTelemetry dependency surfaced in its packaging
        metadata.</dd>
        <dt>Versioning</dt>
        <dd>Its system prompt is composed from memory blocks in a real per-agent git repository with a content
        hash per compiled prompt, which is excellent provenance. But the agent rewrites those blocks itself, so
        the prompt is committed by the agent rather than approved by a human, which is the opposite of the
        approved-version-per-release model.</dd>
        <dt>OTLP</dt>
        <dd>Unverified.</dd>
        <dt>Visual</dt>
        <dd>None. This is a command-line and desktop harness, not a builder.</dd>
      </dl>
      <p class="when">Requirement 1 pass with cloud-gated features, 2 partial, 3 fail</p>
    </div>
  </section>

