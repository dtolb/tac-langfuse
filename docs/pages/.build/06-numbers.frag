  <!-- ============ 03 THE NUMBERS ============ -->
  <section id="numbers">
    <h2><span class="num">03</span> <b>Where the time goes</b> &middot; measured, with caveats</h2>

    <p class="lede-sm">One attribute answers the only question that matters here.
    <code>gen_ai.client.operation.time_to_first_chunk</code> is written natively by the AI SDK on every
    generation, in seconds, and across 33 generations it accounted for the generation span almost exactly.
    Read it before theorising.</p>

    <div class="tablewrap">
      <table>
        <thead>
          <tr><th>Component</th><th>Measured</th><th>The caveat that comes with it</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Framework preamble</td>
            <td>84 ms</td>
            <td>Prompt fetch at 41 ms running alongside memory recall at 79 ms. It was 0 to 84 ms across
            every turn measured, so the framework is not the problem.</td>
          </tr>
          <tr>
            <td>Cold first generation</td>
            <td>3838 ms</td>
            <td>2520 input tokens on a first turn. This is the turn a caller forms an impression on.</td>
          </tr>
          <tr>
            <td>Warm turns</td>
            <td>0.51 to 0.71 s</td>
            <td>Turns 2 and later report 1536 to 2560 cached input tokens, so prompt bloat is paid once
            per conversation rather than per turn.</td>
          </tr>
          <tr>
            <td>Tool-free turn</td>
            <td>586 to 801 ms</td>
            <td>The only fair baseline. Confirm any "it got slower" against one of these.</td>
          </tr>
          <tr>
            <td>Turn with a tool</td>
            <td>1282 to 1433 ms</td>
            <td>Structurally contains the whole tool cycle: model call, tool, second model call.</td>
          </tr>
          <tr>
            <td>Knowledge search</td>
            <td>417 to 1018 ms</td>
            <td>Nothing is spoken while a tool runs, by design.</td>
          </tr>
          <tr>
            <td>Local tool lookup</td>
            <td>1 ms</td>
            <td>A credential-free fake. Real integrations will not look like this.</td>
          </tr>
          <tr>
            <td>Handoff tool</td>
            <td>553 ms</td>
            <td>Two platform calls plus parking the end frame, on a live call.</td>
          </tr>
          <tr>
            <td>First-audio proxy against first token</td>
            <td>0 to 3 ms apart</td>
            <td>A genuine result and a useful negative: nothing queues between model and socket. It is
            <b class="warn">not</b> time to first audio.</td>
          </tr>
          <tr>
            <td>Time between agent turns</td>
            <td>65% of one call</td>
            <td>A blend of playback, caller speech and endpointing. Never quote it as caller talk time.</td>
          </tr>
          <tr>
            <td>Trailing audio after the last token</td>
            <td>2394 ms</td>
            <td>The final reply still playing, plus the hangup. Not visible from inside the app.</td>
          </tr>
          <tr>
            <td>An upstream slow window</td>
            <td>2 to 5 times worse</td>
            <td>A two hour window produced the worst times on record, 6047 to 7723 ms. Provably not the
            app: one container served both a fast and a slow call, with an identical prompt version.
            <b class="warn">Never quote that window as a baseline.</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The lever that is actually top of the list</p>
      <p>On a cold turn the system prompt divides roughly into the base prompt at 33 percent, the injected
      memory block at 35 percent, and five tool definitions at 32 percent. Those are character shares
      rather than token counts: the tokenizer reported 2520 input tokens where characters divided by four
      predicts about 3132, so trust the shares and not the absolutes.</p>
      <p>The memory block is the part that moves. Across one day, same caller, it went 2341, then 1837,
      then 3303, then <b>4412 characters</b>, a net 88 percent growth, and it is not monotonic, so the
      platform rewrites rather than only appends. Nothing in the composition path caps it. The prompt
      cache absorbs it from turn 2 onward, which means it is paid precisely on the turn that is judged.</p>
      <p>Tool descriptions are the next largest block and they are not free to trim: the knowledge search
      description is 1244 characters and is load-bearing, because relevance scores are normalised per
      query and cannot gate on their own.</p>
    </div>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">Two queries that settle an argument</p>
      <p>The resource attribute <code>host.name</code> is a container hash for a containerised run and the
      machine hostname for a host run, which is the fastest way to tell which process produced a trace,
      and how container cold start was ruled out as a cause.</p>
      <p>The memory block size is readable per conversation as a character count on the recall
      observation, with no code change required.</p>
    </div>
  </section>
