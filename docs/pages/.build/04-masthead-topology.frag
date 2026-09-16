  <header>
    <p class="eyebrow">ConversationRelay &middot; Conversation Orchestrator &middot; OpenTelemetry</p>
    <h1>One agent, three channels, every turn traced</h1>
    <p class="thesis">A reference scaffold for customer-facing voice and SMS AI demos. A phone call, a
    text message and a browser all reach <strong>one turn function</strong>. Prompts, the model and the
    tool list are versioned outside the code, and each turn lands in a trace you can argue with.</p>
    <p class="thesis">Everything below was measured on real traffic rather than reasoned about. Where a
    number carries a caveat, the caveat is next to it.</p>
    <div class="facts">
      <span class="fact"><b>3</b> channels</span>
      <span class="fact"><b>1</b> turn function</span>
      <span class="fact"><b>6</b> tools</span>
      <span class="fact"><b>84 ms</b> framework cost</span>
      <span class="fact"><b>86</b> observations in one call</span>
      <span class="fact"><b>0 ms</b> gap in the voice timeline</span>
    </div>
  </header>

  <!-- ============ 01 ARCHITECTURE ============ -->
  <section id="architecture">
    <h2><span class="num">01</span> <b>System architecture</b> &middot; select a node</h2>

    <p class="lede-sm">Two Twilio front doors, one adapter layer, one core. The channel decides how audio
    or text arrives and how a reply is delivered, and nothing else.</p>

    <div class="legend">
      <span><i style="background:var(--plat)"></i> Twilio platform</span>
      <span><i style="background:var(--app)"></i> This repo</span>
      <span><i style="background:var(--obs)"></i> Observability</span>
      <span><i style="background:var(--neutral)"></i> Caller or provider</span>
    </div>

    <div class="topo">
      <svg viewBox="0 0 1200 520" role="img" aria-label="Topology: two Twilio front doors reaching one adapter layer and one agent core, with the model provider, Langfuse, and Twilio Memory and Knowledge attached">
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" fill="#8A9BA6"/>
          </marker>
        </defs>

        <!-- what we actually build -->
        <rect class="gbox" x="508" y="126" width="500" height="248"/>
        <text class="glabel" x="514" y="118">This repo</text>

        <!-- edges -->
        <path class="edge" d="M184,117 H240" marker-end="url(#ah)"/>
        <path class="edge" d="M184,227 H240" marker-end="url(#ah)"/>

        <path class="edge" d="M450,117 H484 V160 H520" marker-end="url(#ah)"/>
        <text class="elabel" x="485" y="107" text-anchor="middle">wss media</text>

        <path class="edge" d="M450,227 H484 V190 H520" marker-end="url(#ah)"/>
        <text class="elabel" x="485" y="250" text-anchor="middle">webhook</text>

        <path class="edge" d="M710,171 H750 V211 H790" marker-end="url(#ah)"/>
        <text class="elabel" x="750" y="163" text-anchor="middle">one turn</text>

        <path class="edge" d="M710,317 H750 V251 H790" marker-end="url(#ah)"/>
        <text class="elabel" x="716" y="333">no credentials</text>

        <path class="edge" d="M890,186 V118" marker-start="url(#ah)" marker-end="url(#ah)"/>
        <text class="elabel" x="900" y="156">tokens</text>

        <path class="edge" d="M990,171 H1010 V161 H1030" marker-start="url(#ah)" marker-end="url(#ah)"/>
        <path class="edge" d="M990,257 H1010 V331 H1030" marker-start="url(#ah)" marker-end="url(#ah)"/>

        <path class="edge dash" d="M850,276 V437 H452" marker-end="url(#ah)"/>
        <text class="elabel" x="660" y="428" text-anchor="middle">handoff tool</text>

        <path class="edge" d="M240,437 H186" marker-end="url(#ah)"/>

        <!-- callers, not clickable -->
        <g>
          <rect x="24" y="86" width="160" height="62" fill="var(--paper)" stroke="var(--neutral)" stroke-width="1.5"/>
          <text class="nlabel" x="40" y="112">Phone call</text>
          <text class="nsub"   x="40" y="130">inbound pstn</text>
        </g>
        <g>
          <rect x="24" y="196" width="160" height="62" fill="var(--paper)" stroke="var(--neutral)" stroke-width="1.5"/>
          <text class="nlabel" x="40" y="222">Text message</text>
          <text class="nsub"   x="40" y="240">inbound sms</text>
        </g>
        <g>
          <rect x="24" y="406" width="160" height="62" fill="var(--paper)" stroke="var(--neutral)" stroke-width="1.5"/>
          <text class="nlabel" x="40" y="432">Human agent</text>
          <text class="nsub"   x="40" y="450">browser softphone</text>
        </g>

        <!-- Twilio platform -->
        <g class="node" data-node="relay" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-relay" aria-label="ConversationRelay">
          <rect x="240" y="86" width="210" height="62" stroke="var(--plat)"/>
          <text class="nlabel" x="256" y="112">ConversationRelay</text>
          <text class="nsub"   x="256" y="130">streaming stt and tts</text>
        </g>

        <g class="node" data-node="orch" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-orch" aria-label="Conversation Orchestrator">
          <rect x="240" y="196" width="210" height="62" stroke="var(--plat)"/>
          <text class="nlabel" x="256" y="222">Conversation Orchestrator</text>
          <text class="nsub"   x="256" y="240">capture rules, extraction</text>
        </g>

        <g class="node" data-node="studio" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-studio" aria-label="Studio flow">
          <rect x="240" y="406" width="210" height="62" stroke="var(--plat)"/>
          <text class="nlabel" x="256" y="432">Studio flow</text>
          <text class="nsub"   x="256" y="450">rings the softphone</text>
        </g>

        <!-- this repo -->
        <g class="node" data-node="adapters" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-adapters" aria-label="Adapter layer">
          <rect x="520" y="140" width="190" height="62" stroke="var(--app)"/>
          <text class="nlabel" x="536" y="166">Adapter layer</text>
          <text class="nsub"   x="536" y="184">the only tac importer</text>
        </g>

        <g class="node" data-node="bench" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-bench" aria-label="Browser bench">
          <rect x="520" y="286" width="190" height="62" stroke="var(--app)"/>
          <text class="nlabel" x="536" y="312">Browser bench</text>
          <text class="nsub"   x="536" y="330">runtime proof</text>
        </g>

        <g class="node" data-node="core" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-core" aria-label="Agent core">
          <rect x="790" y="186" width="200" height="90" stroke="var(--app)"/>
          <text class="nlabel" x="806" y="216">Agent core</text>
          <text class="nsub"   x="806" y="234">one turn function</text>
          <text class="nsub"   x="806" y="252">prompt, model, tools</text>
        </g>

        <!-- providers and platform data -->
        <g class="node" data-node="model" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-model" aria-label="Model provider">
          <rect x="790" y="56" width="200" height="62" stroke="var(--neutral)"/>
          <text class="nlabel" x="806" y="82">Model provider</text>
          <text class="nsub"   x="806" y="100">streamed, tool calling</text>
        </g>

        <g class="node" data-node="memkb" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-memkb" aria-label="Memory and Knowledge">
          <rect x="1030" y="130" width="160" height="62" stroke="var(--plat)"/>
          <text class="nlabel" x="1044" y="156">Memory, Knowledge</text>
          <text class="nsub"   x="1044" y="174">recall and search</text>
        </g>

        <g class="node" data-node="langfuse" role="button" tabindex="0"
           aria-expanded="false" aria-controls="n-langfuse" aria-label="Langfuse">
          <rect x="1030" y="300" width="160" height="62" stroke="var(--obs)"/>
          <text class="nlabel" x="1044" y="326">Langfuse</text>
          <text class="nsub"   x="1044" y="344">prompts in, spans out</text>
        </g>
      </svg>
    </div>
    <p class="hint">Click a node, or focus it and press Enter</p>

    <div class="node-detail detail" id="n-relay" style="--acc:var(--plat);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>The voice front door. It does speech to text and text to speech, and streams
        recognised speech in over a WebSocket while tokens stream back out.</dd>
        <dt>Why here</dt><dd>Barge-in, playback and endpointing stay on the platform, so the agent
        handles text on both channels and never touches audio.</dd>
        <dt>Talks to</dt><dd>The adapter layer over <code>wss://host/ws</code>, plus an action callback
        when the session ends.</dd>
        <dt>Constraint</dt><dd><code>reportInputDuringAgentSpeech</code> defaults to <code>none</code>
        since May 2025. Left at the default, a barge-in stops the audio and the words that caused it are
        never delivered, so the agent goes quiet and cannot hear.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-orch" style="--acc:var(--plat);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>The SMS front door, and the owner of conversation state. Capture rules post
        inbound messages to the agent, and it extracts memory after a conversation closes.</dd>
        <dt>Why here</dt><dd>Cross-conversation memory is a platform feature. The agent contributes
        nothing to extraction beyond letting the conversation close.</dd>
        <dt>Talks to</dt><dd>A status callback pointing at the agent's webhook, in an event envelope
        rather than a Twilio form post.</dd>
        <dt>Constraint</dt><dd>Extraction is post-conversation only, so memory makes the <b>next</b>
        conversation smart. Any honest test needs two conversations with a close in between.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-studio" style="--acc:var(--plat);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>The handoff target. The live call is redirected into a flow that rings a browser
        softphone carrying the reason for the transfer and the transcript so far.</dd>
        <dt>Why here</dt><dd>Ringing a human is routing, not agent logic, and a flow is editable without
        a deploy.</dd>
        <dt>Talks to</dt><dd>The action callback on the voice session, then the browser client.</dd>
        <dt>Constraint</dt><dd>The handoff makes two platform writes before the post that can fail, and
        there is no inverse for either. The failure path leaves state that nothing repairs.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-adapters" style="--acc:var(--app);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>Everything channel specific: the WebSocket handler, the webhook handler, the
        end-of-call frame, the interrupt handler, and the only imports of the Twilio SDK and the agent
        connect library.</dd>
        <dt>Why here</dt><dd>A test fails the build if either package is imported anywhere else, which is
        what makes the credential-free bench a runtime proof rather than a claim about import strings.</dd>
        <dt>Talks to</dt><dd>Both Twilio front doors on one side, the core on the other.</dd>
        <dt>Constraint</dt><dd>The two channels diverge on abort handling. On voice an abort means the
        caller interrupted on purpose, so nothing is said. On SMS an abort can only be our own timeout,
        so the fallback is sent and an error is published.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-bench" style="--acc:var(--app);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>A browser page that streams a complete agent turn over plain HTTP with no
        Twilio credentials present.</dd>
        <dt>Why here</dt><dd>It is the demo you can give on a laptop with one API key, and it is the
        runtime evidence that the core is channel agnostic.</dd>
        <dt>Talks to</dt><dd>The core directly, through the same turn function the phone uses.</dd>
        <dt>Constraint</dt><dd>It proves the turn and nothing else: not signature validation, not
        streaming speech latency, not live barge-in, not platform memory retrieval, not the handoff.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-core" style="--acc:var(--app);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>One function per turn. It resolves the prompt and the caller's memory, resolves
        which tools that prompt version offers, calls the model, runs any tools, and streams the answer
        back as tokens.</dd>
        <dt>Why here</dt><dd>Channel differences are pushed out to the adapters, so a change to how the
        agent thinks is one edit rather than two.</dd>
        <dt>Talks to</dt><dd>The model provider, the platform's memory and knowledge APIs, and the
        observability layer.</dd>
        <dt>Constraint</dt><dd>It does not create its own trace span. The caller creates the span and
        passes it in, because a span created inside would close before the model streamed a token and put
        every model span in a different trace.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-model" style="--acc:var(--neutral);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>The language model, reached through the AI SDK, streaming, with tool calling.</dd>
        <dt>Why here</dt><dd>One file owns the provider, so swapping it is a single edit and the
        telemetry convention stays the same.</dd>
        <dt>Talks to</dt><dd>The core only.</dd>
        <dt>Constraint</dt><dd>Model spans carry the full prompt and completion, so anything personal in
        a prompt is in the trace. The app's own spans are scrubbed; the model's are not.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-memkb" style="--acc:var(--plat);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>Two platform services behind two tools: a memory profile recalled per caller,
        and a knowledge base searched per question.</dd>
        <dt>Why here</dt><dd>Both are managed, and both are the difference between a demo that answers
        and a demo that remembers.</dd>
        <dt>Talks to</dt><dd>The core, through tools built lazily from a live handle.</dd>
        <dt>Constraint</dt><dd>Search relevance scores are normalised per query, so they are not
        comparable across queries and no threshold can separate in scope from out of scope. The tool
        description has to do that work.</dd>
      </dl>
    </div>

    <div class="node-detail detail" id="n-langfuse" style="--acc:var(--obs);margin-top:14px" hidden>
      <dl>
        <dt>What</dt><dd>Self-hosted, and it points both ways: prompts, model and tool list are read from
        it, and every span is written to it.</dd>
        <dt>Why here</dt><dd>Changing behaviour becomes a prompt revision rather than a deploy, and the
        prompt version that produced a trace is on the trace.</dd>
        <dt>Talks to</dt><dd>The core, over the prompt API and an OpenTelemetry exporter.</dd>
        <dt>Constraint</dt><dd>In events-only mode the public read API for traces is disabled. Requests
        answer 404, which means disabled rather than no data, and reading it the other way sends you
        chasing a telemetry bug that does not exist.</dd>
      </dl>
    </div>
  </section>
