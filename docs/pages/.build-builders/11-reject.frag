  <!-- ============ 08 WHAT NOBODY SHOULD ADOPT ============ -->
  <section id="rejected">
    <h2><span class="num">08</span> <b>What nobody should adopt</b> &middot; and the reason, in one row each</h2>

    <p class="lede-sm">Every candidate eliminated in section 01 gets a verdict here, so a reader who skims does
    not have to reconstruct one. Langflow and Sim were the first pass's primary and runner-up and are demoted in
    section 07 rather than here: Langflow for dropping the generation spans by design and executing
    browser-authored Python unsandboxed in the server process, and Sim for retractable spoken text plus a
    proprietary tree that runs at boot and on every tool call under a non-production grant.</p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:900px">
        <thead>
          <tr><th>Candidate</th><th>The verdict, and the detail that decides it</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Dify</td>
            <td>Fails requirement 1 on two counts: the licence is a modified Apache with added conditions that
            GitHub reports as NOASSERTION and that is not approved by the Open Source Initiative, and part of the
            stack the agent node needs ships only as a prebuilt image with no public source, so a required
            component is a binary. Its streaming is also uneven, with the reasoning-loop runner emitting the whole
            final answer as one chunk. <b>Its trace behaviour is the best of the out-of-process candidates, which
            makes the licence the sharper loss.</b></td>
          </tr>
          <tr>
            <td>Flowise</td>
            <td>Fails requirement 1 on licence ambiguity that is not confined to an optional wing, because the
            server entry point imports enterprise middleware unconditionally at boot and the carve-out extends
            open-endedly to files carrying a copyright notice. Separately, it has no versioning at all: the
            chat-flow entity has no version column and no history table, and saving overwrites the flow data in
            place, <b class="warn">which is disqualifying for a scaffold whose headline is versioned
            prompts.</b></td>
          </tr>
          <tr>
            <td>Rivet</td>
            <td>Fails requirement 2. Its chat node coalesces partial output on a timer defaulting to 100 ms, its
            delta cursor is keyed by node id and never reset so the second iteration of a tool loop is sliced
            against the first iteration's length, and text mode closes the stream at the first node-finish event.
            It is the cleanest licence and the cleanest in-process shape on the list, and it has seen no feature
            release in roughly fifteen months.</td>
          </tr>
          <tr>
            <td>Letta Code</td>
            <td>Fails requirement 3, because its extensions are TypeScript files on the harness machine rather
            than anything a builder hosts, and they only help if the agent runs inside that harness. Its prompt
            provenance is genuinely good and points the wrong way for this purpose: the agent rewrites its own
            memory blocks, so the prompt is committed by the agent rather than approved by a human, which is the
            opposite of the approved-version-per-release model.</td>
          </tr>
          <tr>
            <td>LangGraph JS with Studio</td>
            <td>Fails requirement 1 on Studio, which has no source repository and no package, opens a hosted URL,
            and lists a hosted account and an API key as prerequisites, with a self-hosted platform available only
            as an enterprise add-on requiring a purchased key and egress to a vendor endpoint. It also fails
            requirement 3, because Studio has no code editor and no execution runtime, and its assistant
            configuration is selection.</td>
          </tr>
          <tr>
            <td>Coze Studio</td>
            <td>Passes all three requirements and should still not be adopted. The system prompt template states
            the current time at second resolution in its prefix, so provider prompt caching never hits and every
            turn is a cold turn, in a compile-time constant that cannot be configured away. Tracing does not
            exist in the open-source build: its two trace read handlers bind their request and return an empty
            struct with HTTP 200, so the trace panel is wired to endpoints that return nothing, and every
            OpenTelemetry module is an indirect dependency. It cannot be driven statelessly, so a second
            conversation history is unavoidable, and its public chat request cannot pin a version. Engineering has
            largely stopped, with four commits over five and a half months and a latest release seven months old,
            and <a href="https://nvd.nist.gov/vuln/detail/CVE-2026-7023">CVE-2026-7023</a>, a SQL injection with a
            public proof of concept, is reported against that latest release. <b>Its visual authoring is the best
            verified anywhere in this sweep, which is exactly what makes the rest easy to overlook.</b></td>
          </tr>
          <tr>
            <td>VoltAgent</td>
            <td>Fails requirement 3 outright: tools are a schema plus an execute function in TypeScript you host,
            and no route creates an agent, a prompt or a tool. It also cannot retire the incumbent prompt service,
            because the versioning console is not self-hostable below the top commercial tier and the free tier
            allows one prompt, and tool selection is never versioned with a prompt in any case. Two migration
            costs are specific: it emits no <code>gen_ai</code> attributes and does not pass the model SDK's
            telemetry option, and its trace context deliberately deletes the ambient span to force a root, so a
            single tree requires in-process embedding plus an explicit parent-span option.</td>
          </tr>
          <tr>
            <td>Node-RED</td>
            <td>The best in-process shape and the strongest implementation-authoring story in open source, and it
            is not an agent builder. There is no tool-definition mechanism in core: thirty-seven nodes across six
            categories with nothing LLM-shaped, so surfacing a name, a description and an argument schema to a
            model needs either a small third-party package or an adapter in your own source. The streaming
            capability lives entirely in one third-party node by one maintainer, and because its streaming branch
            returns nothing assembled, tool-argument reassembly and message-history accumulation are also your
            code. There is no span model, so the trace regresses to hand instrumentation. <b>Adopting it is less
            replacing the hand-written agent than re-expressing it visually.</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Beyond the twelve,
    where the licence answers the question before any capability does</h3>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Several licences fail requirement 1 before a capability question arises</p>
      <ul>
        <li><strong>n8n</strong> moved to the Sustainable Use License and says itself that it is source-available
        rather than open source, with use restricted to internal business purposes and a separate licence file for
        enterprise paths.</li>
        <li><strong>Arize Phoenix</strong> is Elastic License 2.0 for the server, with only its OpenTelemetry
        package under Apache. Third-party lists calling the whole thing Apache are wrong.</li>
        <li><strong>Open WebUI</strong> is BSD-3-Clause with an added branding clause, reports NOASSERTION, and
        concedes it is not approved by the Open Source Initiative.</li>
        <li><strong>FastGPT</strong> adds a no-SaaS variant, and <strong>Typebot</strong> uses the Functional
        Source License.</li>
        <li><strong>Activepieces</strong> is the textbook open-core failure for this use, with an MIT core, a
        commercial licence over its enterprise packages, and <b class="warn">agents and chat explicitly excluded
        from the Community Edition</b>, which is precisely the capability needed.</li>
        <li><strong>Botpress</strong> self-hosting is sunset, so it is a hosted service in practice, and
        <strong>PromptLayer</strong> has no self-hosted option at all.</li>
      </ul>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">A whole category is mistaken for agent builders and fails requirement 3 by construction</p>
      <p>Agenta, Opik, Lunary, Helicone, PromptLayer and Phoenix observe or store prompts. They do not orchestrate
      a turn and they do not execute tools. Arize states the principle in its own words, that it deliberately did
      not build prompt management because applications depending on an observability tool at runtime is an
      ill-advised design. Pezzo is dead, with its last release in May 2024 and an archived examples repository.
      Latitude relicensed to MIT and pivoted to monitoring, so its current repository is trace search and
      redaction rather than an agent builder.</p>
      <p>Any of these could replace part of the incumbent trace service, and none replaces the agent. Note the one
      twist section 05 introduces: <b>in shape (c) this category stops being disqualified</b>, because a tool that
      cannot stream a token is a perfectly good place to write a prompt.</p>
    </div>

    <div class="callout">
      <p class="dtitle">Retired or dormant projects to leave alone</p>
      <ul>
        <li><strong>Microsoft Prompt Flow</strong> ended feature development with its runtime images frozen,
        including for security updates, and its successor is a code SDK rather than a builder.</li>
        <li><strong>AutoGen Studio</strong> is out because its parent has been in maintenance mode, and its
        declarative model can only express serialisable properties, so callables and hooks cannot be authored in
        the interface at all.</li>
        <li><strong>Superagent</strong>'s organisation pivoted to AI security, and <strong>Inferable</strong>'s
        last commits across its repositories are from early 2025, with siblings archived.</li>
      </ul>
    </div>

    <div class="callout">
      <p class="dtitle">Wrong-shape candidates, named so nobody re-litigates them</p>
      <ul>
        <li><strong>Julep</strong> is otherwise a genuine contender, with Apache-2.0, a container stack and a real
        tool system, and its own <a href="https://docs.julep.ai/FAQ">FAQ</a> states that streaming is planned and
        not implemented.</li>
        <li><strong>Chainlit</strong> and <strong>CrewAI Studio</strong> are front ends over code you write.</li>
        <li><strong>Kestra</strong>'s execution model produces task outputs rather than token deltas.</li>
        <li><strong>RAGFlow</strong> is a strong retrieval product whose design centre is neither tool authoring
        nor streaming to an external relay.</li>
        <li><strong>Vapi</strong> and <strong>Bland</strong> are not open source.</li>
      </ul>
    </div>

    <div class="callout" style="--acc:var(--neutral)">
      <p class="dtitle">The three that are permissively licensed, self-hostable, and answering a different question</p>
      <p>Pipecat, LiveKit Agents and Vocode own speech recognition, synthesis and interruption, so they replace
      ConversationRelay rather than sitting behind it. Pipecat Flows is the only genuinely visual voice-agent
      authoring tool in open source, which makes it worth a deliberate decision rather than a dismissal. That
      decision is argued at <a href="https://pages-4296.twil.io/convo-vs-livekit">convo-vs-livekit</a>, including
      the point that the alternative's own telephony quickstart tells you to connect a Twilio SIP trunk, and the
      counted move from vendor-run conversation services to customer-operated subsystems.</p>
    </div>
  </section>
