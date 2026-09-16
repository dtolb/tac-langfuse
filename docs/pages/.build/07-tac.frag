  <!-- ============ 04 LIBRARY LESSONS ============ -->
  <section id="tac">
    <h2><span class="num">04</span> <b>Working with the Agent Connect library</b> &middot; assumption against reality</h2>

    <p class="lede-sm">The framework that boots both channels, owns the WebSocket, and provides the memory,
    knowledge and handoff tools. Everything below was found by reading its source or by watching it run at
    version 2.2.0, and the right instinct throughout was to <b>extend it rather than work around it</b>.
    Its 31 test files are usable as evidence, which is worth knowing because it is easy to assume a
    vendor bundle ships none.</p>

    <div class="lblock">
      <h3>A &middot; Boot and wiring</h3>
      <div class="tablewrap">
        <table class="wide-first">
          <thead>
            <tr><th>The assumption</th><th>What is actually true</th><th>Symptom when you get it wrong</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Registration order is cosmetic</td>
              <td>The server constructor snapshots channels, and the inbound webhook route is only
              registered if a webhook channel already exists.</td>
              <td>A 404 on the webhook with one log line about no channels configured.</td>
            </tr>
            <tr>
              <td>Construction is local work</td>
              <td>Creating the client makes a network call to read the orchestrator configuration, and it
              rethrows.</td>
              <td>Boot fails for reasons outside the process, so config resolution has to tolerate it.</td>
            </tr>
            <tr>
              <td>Optional config keys can be omitted</td>
              <td>Several path options wrap a default in a preprocess step, so the key is required even
              though a value is not. Pass explicit undefined.</td>
              <td>A schema error at construction, from a key you deliberately left out.</td>
            </tr>
            <tr>
              <td>The library reads the environment for you</td>
              <td>It can, and taking that path makes it a second place the environment is read.</td>
              <td>Two sources of truth for configuration, and a boot that cannot degrade politely.</td>
            </tr>
            <tr>
              <td>Inbound SMS arrives on the number's webhook</td>
              <td>It arrives through the orchestrator configuration's status callback plus bidirectional
              capture rules, in an event envelope rather than a form post.</td>
              <td>A 200 response, an unhandled-event log line, and total silence.</td>
            </tr>
            <tr>
              <td>The server can own the listen call</td>
              <td>Its start method calls listen itself, which forces two mutually exclusive boot paths
              where only one of them listens.</td>
              <td>Either a double listen or a process that never binds, depending on which path you took.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="lblock">
      <h3>B &middot; What it does not do, so you must</h3>
      <div class="tablewrap">
        <table class="wide-first">
          <thead>
            <tr><th>The assumption</th><th>What is actually true</th><th>Symptom when you get it wrong</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>It composes the prompt from memory for you</td>
              <td>Its prompt builder has zero callers inside the library. What reaches the model is
              entirely the host's decision.</td>
              <td>You believe a memory block is being injected when nothing is. This corrected an
              assumption that survived two whole tasks here.</td>
            </tr>
            <tr>
              <td>Every channel hands you an abort signal</td>
              <td>Only the voice path does. A text turn has no timeout unless you synthesize one.</td>
              <td>An unbounded turn leaves its span unended, so the turn never reaches the trace at all.</td>
            </tr>
            <tr>
              <td>There is an end-session method</td>
              <td>There is not. It builds the end frame for a handoff and parks it, and only drains it on
              the non-streaming send path.</td>
              <td>On a streaming channel the parked frame is never sent. The socket is public, so writing
              the documented frame yourself needs no internals.</td>
            </tr>
            <tr>
              <td>Returning an empty reply is safe</td>
              <td>An empty string is a silent no-reply, and a thrown error inside the handler is caught
              and logged.</td>
              <td>Nothing is sent and nothing is raised. Four further conditions drop an inbound message
              the same way, all of them logging rather than raising.</td>
            </tr>
            <tr>
              <td>The message-ready callback is per channel</td>
              <td>It is a single global slot on the client, not on the channel.</td>
              <td>The second channel silently replaces the first. Branch on the channel inside one
              handler.</td>
            </tr>
            <tr>
              <td>Its callback route can double as your call-action URL</td>
              <td>That route answers plain text, never markup, and its payload schema has no field for
              handoff data, so a non-strict parse strips it.</td>
              <td>The callback keeps arriving and looks healthy while the handoff data is discarded and
              the call drops. This one refuted an earlier written conclusion that the two could coexist.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="lblock">
      <h3>C &middot; Memory, and the shape of the tools</h3>
      <div class="tablewrap">
        <table class="wide-first">
          <thead>
            <tr><th>The assumption</th><th>What is actually true</th><th>Why it matters</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Memory mode controls what the model sees</td>
              <td>It controls exactly one thing: whether recall runs, and how often. The response is
              handed to your callback and you decide what to do with it.</td>
              <td>Choosing a mode is a latency decision. Composing the block is a separate, host-owned
              decision.</td>
            </tr>
            <tr>
              <td>A conversation can benefit from its own memory</td>
              <td>Extraction is post-conversation only.</td>
              <td>Memory makes the <b>next</b> conversation smart. A demo that texts once and expects
              recall will fail, correctly.</td>
            </tr>
            <tr>
              <td>Recall failure is a no-op</td>
              <td>On failure it falls back to listing the current conversation's communications with no
              limit.</td>
              <td>The fallback can render the conversation into its own prompt, which is why the compose
              step here makes that section structurally unreachable rather than trusting a config value.</td>
            </tr>
            <tr>
              <td>A tool in the catalog is a tool the model has</td>
              <td>A prompt has to name it. Typecheck, a full test suite, the boot log, the health route
              and a tool-resolution diagnostic all passed while two new tools were dead.</td>
              <td>Green checks do not prove a tool is offered. Only a real turn does.</td>
            </tr>
            <tr>
              <td>Voice and digital handoff need separate tools</td>
              <td>There is one tool that branches on the session channel internally, and the two wire
              shapes are not interchangeable.</td>
              <td>Building two was a decision that had to be reversed after reading the source.</td>
            </tr>
            <tr>
              <td>Default tool descriptions are fine</td>
              <td>The default handoff description invites a transfer whenever the model feels stuck.</td>
              <td>Overriding descriptions is behaviour work, not copy editing.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Shutdown is where three timeouts disagree</p>
      <p>The library registers a graceful-shutdown plugin with no options, which means a 10 second
      watchdog, and separately waits up to 30 seconds for WebSockets to drain. The plugin runs every
      handler before closing the server, so a host flush registered there sits behind the 30 second wait
      while the watchdog exits at 10. The last turn is lost, silently.</p>
      <p>Register the plugin yourself with a longer timeout before starting, put the drain in the
      pre-close hook rather than the close hook, since the close queue runs last and would deadlock
      against the connections it is waiting on, and do not add your own signal handler: the plugin
      installs one and warns about duplicates. Registering the plugin twice throws.</p>
    </div>
  </section>
