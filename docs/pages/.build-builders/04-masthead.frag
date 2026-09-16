</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">Open-source agent builders &middot; ConversationRelay &middot; Twilio Agent Connect</p>
    <h1>Which agent builder can sit behind the relay</h1>
    <p class="thesis">A self-hostable builder is supposed to be the place a non-engineer edits the system
    prompt, picks which tools this version may use, and ships that change without a deploy. Twelve of them
    were read at source against three requirements: self-hostable open source in a local container stack with
    no hosted control plane and no paid gate on a feature the design needs, token-level streaming out of the
    runtime, and tool definitions <em>and</em> their implementations authored inside the builder rather than in
    the application's own source. <strong>One candidate satisfies the first two at the exact shape of the
    integration seam and fails the third on the vendor's own words</strong>, and that candidate is still the
    recommendation, because the alternative is reimplementing the platform's own integrations to satisfy a
    rule.</p>
    <p class="thesis">Two facts about the SDK set the shape of every answer, and both were read from the
    shipped Agent Connect bundle rather than from documentation. <code>onMessageReady</code> is not the
    streaming path; it is the non-streaming auto-send convenience, and returning a string from it makes the
    SDK send one frame with <code>last: true</code>. The streaming path is
    <code>VoiceChannel.sendStreamingResponse()</code>, a public method whose only contract is an
    <code>AsyncIterable&lt;string&gt;</code>, performing one <code>ws.send</code> per chunk inside its own
    <code>for await</code> loop. <strong>That method is the integration seam, and it does not care whether the
    iterable is fed by a library call or by a socket read.</strong> The fork is therefore not about transport.
    It is about which shape keeps a single trace, which builder lets a non-engineer write a tool, and what a
    provider prompt cache does to the first turn of a call.</p>
    <p class="thesis">Scope. The system architecture, the anatomy of a turn, the assumption-and-reality tables
    and the measured latency table are published at
    <a href="https://pages-4296.twil.io/agent-scaffold-architecture">agent-scaffold-architecture</a> and are
    not restated here. The instrumentation this decision puts at risk, and the injection surface that produced
    it, are at <a href="https://pages-4296.twil.io/tac-otel-instrumentation">tac-otel-instrumentation</a>;
    section 03 below is the loss side of that page's gain, so read it after this one rather than instead of
    it. The separate question of replacing the relay layer itself rather than the model behind it is argued at
    <a href="https://pages-4296.twil.io/convo-vs-livekit">convo-vs-livekit</a>, whose architectural
    conclusions are cited here and whose figures were not rechecked for this page.</p>
    <div class="facts">
      <span class="fact"><b>12</b> candidates read at source</span>
      <span class="fact"><b>3</b> filtering requirements</span>
      <span class="fact"><b>5</b> embeddable in Node</span>
      <span class="fact"><b>1 of 12</b> keeps a trace whole over HTTP</span>
      <span class="fact"><b>2</b> pass all three and are still rejected</span>
      <span class="fact"><b>0</b> candidates were run</span>
    </div>
  </header>
