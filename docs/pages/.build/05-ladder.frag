  <!-- ============ 02 ANATOMY OF A TURN ============ -->
  <section id="turn">
    <h2><span class="num">02</span> <b>Anatomy of a turn</b> &middot; select any hop
      <span class="bulk">
        <button data-bulk="open" data-scope="#turn">Expand all</button>
        <button data-bulk="close" data-scope="#turn">Collapse all</button>
      </span>
    </h2>

    <p class="lede-sm">One voice turn, in the order the spans appear. A text turn is the same ladder
    without hops 01, 02, 09 and 10: the message arrives on a webhook and the reply is one complete
    answer rather than a stream.</p>

    <div class="lblock">
      <h3>A &middot; The turn itself</h3>
      <p class="sub">Numbers in the panels are from an instrumented call and carry the caveat they were
      measured with.</p>
      <div class="lanes" aria-hidden="true">
        <div class="lane"><span class="dot neutral"></span><span>Caller</span></div>
        <div class="lane"><span class="dot plat"></span><span>Relay</span></div>
        <div class="lane"><span class="dot app"></span><span>Adapter</span></div>
        <div class="lane"><span class="dot app"></span><span>Core</span></div>
        <div class="lane"><span class="dot plat"></span><span>Model, data</span></div>
      </div>

      <div class="spanwrap">
      <div class="ladder">
        <div class="rails" aria-hidden="true">
          <i style="left:10%"></i><i style="left:30%"></i><i style="left:50%"></i>
          <i style="left:70%"></i><i style="left:90%"></i>
        </div>
        <span class="spanmark" aria-hidden="true"><i></i><em>caller.turn spans the gap</em></span>

        <div class="step" id="hop-01" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d01" data-dir="r" style="--from:10%;--to:30%">
            <span class="wlabel"><span class="hdr"><span class="n">01</span><span class="chev">&#9656;</span></span>
            <span class="t">Caller speaks, speech recognition finalises</span></span>
          </button>
          <div class="detail" id="d01" hidden>
            <p class="what">Streaming recognition decides the caller has stopped and emits a final
            transcript.</p>
            <p class="why">This is inside <code>caller.turn</code>, the span that covers every instant
            between two agent turns. It is a <b>blend</b> of bot playback, caller speech and endpointing,
            and it was 65 percent of one real call. Do not read it as how long the caller talked.</p>
          </div>
        </div>

        <div class="step" id="hop-02" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d02" data-dir="r" style="--from:30%;--to:50%">
            <span class="wlabel"><span class="hdr"><span class="n">02</span><span class="chev">&#9656;</span></span>
            <span class="t">A prompt frame arrives on the socket</span></span>
          </button>
          <div class="detail" id="d02" hidden>
            <p class="what">The transcript arrives as a <code>prompt</code> message. The timestamp is
            captured as the first statement of the handler, and the turn span is back-dated to it.</p>
            <p class="why">The turn span opens here and <code>caller.turn</code> closes here, which is why
            the two tile with a measured 0 ms between them. Everything before this point, socket frame
            parsing and queue serialisation, is not measurable from inside the app.</p>
          </div>
        </div>

        <div class="step" id="hop-03" style="--acc:var(--app)">
          <button class="row" aria-expanded="false" aria-controls="d03" data-dir="r" style="--from:50%;--to:70%">
            <span class="wlabel"><span class="hdr"><span class="n">03</span><span class="chev">&#9656;</span></span>
            <span class="t">The core runs the turn inside that span</span></span>
          </button>
          <div class="detail" id="d03" hidden>
            <p class="what">The adapter calls the turn function and gets back a token stream plus a
            promise that settles when the turn is done.</p>
            <p class="why">The adapter owns the span, not the core. A span created inside the core would
            close before the model streamed a token and every model span would land in a different trace.
            The token stream also has to be consumed before the caller's next await, or the first-token
            timing comes back null while the caller still hears the whole answer.</p>
          </div>
        </div>

        <div class="step" id="hop-04" style="--acc:var(--obs)">
          <button class="row" aria-expanded="false" aria-controls="d04" data-dir="b" style="--from:70%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">04</span><span class="chev">&#9656;</span></span>
            <span class="t">Prompt and memory resolve in parallel</span></span>
          </button>
          <div class="detail" id="d04" hidden>
            <p class="what">The prompt version, its model and its tool list are fetched from the prompt
            store while the caller's memory profile is recalled from the platform.</p>
            <p class="why">Measured at 41 ms for the prompt fetch running alongside 79 ms for the recall,
            which is the whole framework cost of <b>84 ms</b> per turn. Everything else in a slow turn is
            model time. If the prompt store is unreachable the compiled-in default answers and reports
            its version as <code>fallback</code>, so a degraded demo is visible rather than silently
            different.</p>
          </div>
        </div>

        <div class="step" id="hop-05" style="--acc:var(--neutral)">
          <button class="row" aria-expanded="false" aria-controls="d05" data-dir="b" style="--from:70%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">05</span><span class="chev">&#9656;</span></span>
            <span class="t">Model call, first token</span></span>
          </button>
          <div class="detail" id="d05" hidden>
            <p class="what">One streamed model call with the resolved tool definitions attached.</p>
            <p class="why">The AI SDK writes <code>gen_ai.client.operation.time_to_first_chunk</code>
            natively on every generation, in seconds, and across 33 generations it accounted for the
            generation span almost exactly. That turns "is it us or the model" into one query. A cold
            first turn measured 3838 ms here against 0.51 to 0.71 s once the prompt cache was warm.</p>
          </div>
        </div>

        <div class="step" id="hop-06" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d06" data-dir="b" style="--from:70%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">06</span><span class="chev">&#9656;</span></span>
            <span class="t">A tool runs, and nothing is spoken</span></span>
          </button>
          <div class="detail" id="d06" hidden>
            <p class="what">The model asks for a tool, the tool executes, and the result goes back as
            another step.</p>
            <p class="why">Measured: a local lookup at 1 ms, a knowledge search at 417 to 1018 ms, a
            handoff at 266 ms. The caller hears silence for that whole time, which is the argument for a
            filler line rather than for a faster tool. Tools that need live credentials are built lazily
            inside execute, so a missing credential is a structured miss the model can talk about instead
            of a crash at boot.</p>
          </div>
        </div>

        <div class="step" id="hop-07" style="--acc:var(--neutral)">
          <button class="row" aria-expanded="false" aria-controls="d07" data-dir="l" style="--from:70%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">07</span><span class="chev">&#9656;</span></span>
            <span class="t">Second model call composes the answer</span></span>
          </button>
          <div class="detail" id="d07" hidden>
            <p class="what">With the tool result in context, the model produces the words the caller will
            hear.</p>
            <p class="why">This is why a tool turn's time to first token structurally contains the whole
            tool cycle. Tool-free turns measured 586 to 801 ms on a healthy model against 1282 to 1433 ms
            for tool turns, so comparing the two as if they were the same thing invents a regression.</p>
          </div>
        </div>

        <div class="step" id="hop-08" style="--acc:var(--app)">
          <button class="row" aria-expanded="false" aria-controls="d08" data-dir="l" style="--from:50%;--to:70%">
            <span class="wlabel"><span class="hdr"><span class="n">08</span><span class="chev">&#9656;</span></span>
            <span class="t">Tokens stream back to the adapter</span></span>
          </button>
          <div class="detail" id="d08" hidden>
            <p class="what">The turn function yields tokens as they arrive; the adapter forwards each one
            immediately.</p>
            <p class="why">The turn records a first-audio proxy at the first non-empty token. It landed
            within 0 to 3 ms of first-token on all six turns of a call, which is a useful negative: it
            proves nothing queues between the model and the socket. It is not time to first audio, and
            presenting it that way would be wrong.</p>
          </div>
        </div>

        <div class="step" id="hop-09" style="--acc:var(--app)">
          <button class="row" aria-expanded="false" aria-controls="d09" data-dir="l" style="--from:30%;--to:50%">
            <span class="wlabel"><span class="hdr"><span class="n">09</span><span class="chev">&#9656;</span></span>
            <span class="t">Each token sent, then the last marker</span></span>
          </button>
          <div class="detail" id="d09" hidden>
            <p class="what">Tokens go out on the socket as they arrive, then an end-of-turn marker closes
            the turn.</p>
            <p class="why">The end marker is only emitted if at least one token was sent, so an empty
            answer closes nothing and the caller holds an open line forever. That one has bitten: an
            empty answer must speak a fallback. Guarding on "we accumulated some text" is also wrong,
            because text accumulates before the send.</p>
          </div>
        </div>

        <div class="step" id="hop-10" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d10" data-dir="l" style="--from:10%;--to:30%">
            <span class="wlabel"><span class="hdr"><span class="n">10</span><span class="chev">&#9656;</span></span>
            <span class="t">Speech synthesis plays the answer</span></span>
          </button>
          <div class="detail" id="d10" hidden>
            <p class="what">The platform speaks the tokens, and the next <code>caller.turn</code> is
            already running.</p>
            <p class="why">First byte of audio and end of playback are not exposed, so this is the part of
            the call the traces cannot see. It shows up as the tail of the root span, 2394 ms on the
            instrumented call, and as the bulk of every <code>caller.turn</code>. Getting the real number
            means Voice Insights or media stream marks.</p>
          </div>
        </div>

        <div class="step" id="hop-11" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d11" data-dir="r" style="--from:10%;--to:50%">
            <span class="wlabel"><span class="hdr"><span class="n">11</span><span class="chev">&#9656;</span></span>
            <span class="t">If the caller interrupts</span></span>
          </button>
          <div class="detail" id="d11" hidden>
            <p class="what">A barge-in stops playback and delivers an interrupt, then the caller's words
            arrive as the next prompt.</p>
            <p class="why">Three things are load-bearing here. The abort signal must be passed explicitly
            into the send, or the fallback resolves to undefined and the caller is talked over with the
            answer they just interrupted. The interrupt handler <b>parks</b> the boundary instant rather
            than ending the span, because the turn's output and tool list are written after the stream
            settles and would be dropped on an already-ended span. And a pending hangup has to be
            cancelled, or the call ends on someone a turn later.</p>
            <p class="why">Barge-in history keeps the generated partial, which overstates what the caller
            actually heard. The ground truth arrives after history is appended and is deliberately not
            written back.</p>
          </div>
        </div>
      </div>
      </div>
    </div>

    <div class="lblock">
      <h3>B &middot; After the last turn</h3>
      <p class="sub">The half that is easy to get wrong, because most of it happens after anyone is
      listening.</p>
      <div class="lanes" aria-hidden="true">
        <div class="lane"><span class="dot neutral"></span><span>Caller</span></div>
        <div class="lane"><span class="dot plat"></span><span>Relay</span></div>
        <div class="lane"><span class="dot app"></span><span>Adapter</span></div>
        <div class="lane"><span class="dot app"></span><span>Core</span></div>
        <div class="lane"><span class="dot plat"></span><span>Model, data</span></div>
      </div>

      <div class="ladder">
        <div class="rails" aria-hidden="true">
          <i style="left:10%"></i><i style="left:30%"></i><i style="left:50%"></i>
          <i style="left:70%"></i><i style="left:90%"></i>
        </div>

        <div class="step" id="hop-12" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d12" data-dir="r" style="--from:30%;--to:50%">
            <span class="wlabel"><span class="hdr"><span class="n">12</span><span class="chev">&#9656;</span></span>
            <span class="t">The session ends, one way or another</span></span>
          </button>
          <div class="detail" id="d12" hidden>
            <p class="what">The caller hangs up, or the agent decides to. An agent hangup is a two-step
            mechanism: the tool records an intent, and the frame goes out after the farewell has
            streamed.</p>
            <p class="why">Tools run inside the model loop, before the turn's text exists, so hanging up
            in the tool would cut off the goodbye. Queued audio does drain before the socket closes,
            measured at 1.75 s on a real call, which the docs do not promise. A handoff beats a pending
            hangup unconditionally, because two end frames on one socket is undefined behaviour.</p>
          </div>
        </div>

        <div class="step" id="hop-13" style="--acc:var(--obs)">
          <button class="row" aria-expanded="false" aria-controls="d13" data-dir="r" style="--from:50%;--to:70%">
            <span class="wlabel"><span class="hdr"><span class="n">13</span><span class="chev">&#9656;</span></span>
            <span class="t">Call statistics, then the root span closes</span></span>
          </button>
          <div class="detail" id="d13" hidden>
            <p class="what">The root span takes its metadata from a stats call that finalises the call
            first and reports second: turn count, aborted count, total caller time, first-audio median
            and maximum, and why the call closed.</p>
            <p class="why">There is deliberately no accessor to call in the wrong order, because root
            metadata computed from a half-open call would be quietly wrong rather than obviously wrong.</p>
          </div>
        </div>

        <div class="step" id="hop-14" style="--acc:var(--obs)">
          <button class="row" aria-expanded="false" aria-controls="d14" data-dir="r" style="--from:70%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">14</span><span class="chev">&#9656;</span></span>
            <span class="t">Spans flush before the process exits</span></span>
          </button>
          <div class="detail" id="d14" hidden>
            <p class="what">On shutdown the conversation is closed first, then telemetry is flushed.</p>
            <p class="why">That order is not cosmetic. An unended span never arrives, so flushing first
            ships every turn while dropping the conversation they hang from. The flush itself has to go
            through the provider's delegate, because the proxy the API hands you has no flush method and
            calling it optionally is a silent no-op.</p>
          </div>
        </div>

        <div class="step" id="hop-15" style="--acc:var(--plat)">
          <button class="row" aria-expanded="false" aria-controls="d15" data-dir="r" style="--from:30%;--to:90%">
            <span class="wlabel"><span class="hdr"><span class="n">15</span><span class="chev">&#9656;</span></span>
            <span class="t">Later, the platform extracts memory</span></span>
          </button>
          <div class="detail" id="d15" hidden>
            <p class="what">When the conversation closes, extraction writes observations to the caller's
            profile, which the next conversation recalls.</p>
            <p class="why">Measured about 2 seconds from closed to the observation existing. The slow part
            is the close itself, which took 5 minutes 36 seconds on an ordinary conversation and 32
            seconds after a handoff, because the handoff writes an inactive state that short-circuits the
            wait. Extraction also survives a handoff, which is the opposite of what was expected.</p>
          </div>
        </div>
      </div>
    </div>
  </section>
