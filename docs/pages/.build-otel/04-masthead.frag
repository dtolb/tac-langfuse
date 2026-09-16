</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">Twilio Agent Connect &middot; OpenTelemetry &middot; GenAI conventions</p>
    <h1>Instrumenting a library that ships no telemetry</h1>
    <p class="thesis">Grepping the shipped Agent Connect 2.2.0 bundle for <code>opentelemetry</code>,
    <code>AsyncLocalStorage</code>, <code>trace.getTracer</code> and <code>traceparent</code> returns
    <strong>zero matches</strong>, and the upstream repository has never carried an issue or pull request
    mentioning OpenTelemetry, tracing, spans or metrics. The total timing surface the library hands you is
    three numbers, none of which it measured of itself. Everything else you trace, you time from the
    outside.</p>
    <p class="thesis">The correction to make before designing a single span: <strong>the response callback
    is not the streaming path.</strong> <code>onMessageReady</code> returns a string and the library sends
    it as one finished frame. Streaming happens because
    <code>VoiceChannel.sendStreamingResponse</code> is a public method you call back into with your own
    <code>AsyncIterable&lt;string&gt;</code>. The seam is not a callback you are handed. Design a turn span
    around the callback and the voice half of your instrumentation measures the wrong interval.</p>
    <p class="thesis">Scope. This page is about the injection surface, the code, and the limits. The
    system architecture, the hop-by-hop anatomy of a turn, the twelve-row latency table and the eighteen
    Agent Connect assumption-against-reality findings are already published at
    <a href="https://pages-4296.twil.io/agent-scaffold-architecture">agent-scaffold-architecture</a> and
    are not restated here. The decision to move the agent core out to a visual agent builder, which is
    what puts most of this instrumentation at risk, is argued at
    <a href="https://pages-4296.twil.io/tac-agent-builder-options">tac-agent-builder-options</a>. Read
    section 04 below before that one, because this is the cost side of that trade.</p>
    <div class="facts">
      <span class="fact"><b>0</b> telemetry lines in the library</span>
      <span class="fact"><b>3</b> timings it reports at all</span>
      <span class="fact"><b>5</b> code layers</span>
      <span class="fact"><b>2 of 5</b> executed, not just compiled</span>
      <span class="fact"><b>0 ms</b> gap in the tiled timeline</span>
      <span class="fact"><b>65%</b> of one call in a blended span</span>
    </div>
  </header>
