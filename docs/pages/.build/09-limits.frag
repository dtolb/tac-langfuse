  <!-- ============ 06 WHAT IS PROVEN ============ -->
  <section id="proven">
    <h2><span class="num">06</span> <b>What is proven, and what is not</b></h2>

    <div class="cards">
      <div class="card" style="--acc:var(--obs)">
        <h4>Proven on real traffic</h4>
        <span class="api">measured, not inferred</span>
        <ul>
          <li>Both channels answered live, by the same turn function.</li>
          <li><strong>Memory across separate conversations</strong>, with the recall arriving on the next
          conversation and no tool call.</li>
          <li>Barge-in on real audio, twice in one call.</li>
          <li>A knowledge search answering a policy question on both channels.</li>
          <li>An agent-initiated hangup, with the goodbye audible before the socket closed.</li>
          <li>A caller transferred to a browser softphone that a human answered, carrying the reason and
          the transcript.</li>
          <li>A held event stream surviving 184.7 seconds behind a proxy, ending only when the process
          stopped.</li>
          <li>A clean shutdown that force-closed that connection and exited zero in under a second.</li>
        </ul>
        <p class="when">Each verified by executing it</p>
      </div>

      <div class="card" style="--acc:var(--app)">
        <h4>Not exercised yet</h4>
        <span class="api">honest gaps</span>
        <ul>
          <li><strong>The barge-in telemetry path.</strong> The interrupt attributes are proven by tests
          and a diagnostic; both instrumented calls report zero aborted turns.</li>
          <li><strong>The long shutdown drain.</strong> It needs a termination signal mid-call, which has
          not happened.</li>
          <li><strong>A signature rejection on the media socket</strong>, which is invisible by
          construction.</li>
          <li>First byte of audio and end of playback, which the platform does not expose.</li>
          <li>Reasoning-effort tuning. Model parameters were empty on all 33 generations, and no
          reasoning-token attribute exists on the span, so this is a hypothesis rather than a measurement.</li>
        </ul>
        <p class="when">Named rather than quietly omitted</p>
      </div>

      <div class="card" style="--acc:var(--plat)">
        <h4>Debt taken on purpose</h4>
        <span class="api">a demo scaffold, not a service</span>
        <ul>
          <li>Four unauthenticated endpoints on a stable public host: one mints a real voice access
          token, one spends the model key unmetered, one fabricates observability events, and one lists
          the names of unset variables.</li>
          <li>Conversation state is process local, so a restart drops every conversation mid-call and two
          instances would not share them.</li>
          <li>Basic auth is not the bolt-on it looks like: browsers only show the dialog for top-level
          navigations, fetch gets a bare 401, and an event stream cannot send the header at all.</li>
          <li>The mitigation is operational. The stack does not restart itself after a reboot, so bringing
          the public surface up is always an explicit act.</li>
        </ul>
        <p class="when">Accepted to get it live and testable</p>
      </div>
    </div>
  </section>

  <!-- ============ 07 TRANSFERABLE ============ -->
  <section id="rules">
    <h2><span class="num">07</span> <b>Rules worth carrying to the next build</b></h2>

    <div class="tablewrap">
      <table class="wide-first">
        <thead>
          <tr><th>Rule</th><th>What it cost to learn</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Degrade loudly at boot, never refuse to start</td>
            <td>An empty configuration still boots here. Each missing variable logs what it costs, a health
            route reports a capability map, and only the routes that genuinely cannot work refuse. A demo
            that will not start is undebuggable at the worst possible moment.</td>
          </tr>
          <tr>
            <td>A green check is not a proof</td>
            <td>Typecheck, a full suite, the boot log, a health route and a tool-resolution diagnostic all
            passed while two tools were dead. Only a real turn caught it.</td>
          </tr>
          <tr>
            <td>Instrument the gaps, not just the work</td>
            <td>Before tiling the timeline, a 57 second call showed 12 seconds of spans and 45 seconds of
            unexplained gap. Covering the gap with its own span turned "where did the time go" into a
            reading rather than an investigation.</td>
          </tr>
          <tr>
            <td>Find the native attribute before theorising</td>
            <td>The one attribute that answers "us or the model" was already on every generation and
            nothing here had read it. The whole latency investigation became one query.</td>
          </tr>
          <tr>
            <td>Enforce architectural boundaries with tests</td>
            <td>The rules that matter here all fail silently: a vendor import in the wrong folder, a
            console call bypassing the scrubber, an undocumented environment variable. Each is a test, and
            some tests assert the rule sets themselves are intact.</td>
          </tr>
          <tr>
            <td>Restart or rebuild before concluding a fix failed</td>
            <td>A verified-correct cache appeared to do nothing because the process predated the commit by
            53 minutes. Separately, a real call ran against a container image built hours earlier. Both
            read as broken code.</td>
          </tr>
          <tr>
            <td>Keep the vendor library in one folder</td>
            <td>One folder imports the platform SDK and the agent framework. That is what lets a browser
            drive the whole agent with no credentials, which is a runtime proof rather than a claim.</td>
          </tr>
          <tr>
            <td>A claim inherited from an approved plan is still a claim</td>
            <td>Approval means the approach is agreed, not that every factual assertion in it was checked.
            The written record for this build corrects itself in more than twenty places, and several of
            those corrections were confidently worded first time around.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Two test-method traps that produce clean, wrong numbers</p>
      <p>Texting the agent from a second number on the same account doubles every reply. Both message legs
      share the same pair of endpoints, so the capture rule matches each one, and the mechanism is two
      creation events about 300 ms apart. Measured against an external handset it is exactly one reply per
      inbound. Any "reply count" from an on-account number is inflated.</p>
      <p>Knowledge search scores are normalised per query. An out-of-scope question scored 0.816 while the
      in-scope question's own second hit scored 0.54, so no threshold can separate them and the tool
      description has to carry the scoping.</p>
    </div>
  </section>

  <!-- ============ 08 VERIFICATION ============ -->
  <section id="verification">
    <h2><span class="num">08</span> <b>Verification and open items</b></h2>

    <div class="tablewrap">
      <table class="wide-first">
        <thead>
          <tr><th>Item</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Every number on this page</td>
            <td>Taken from the project's own measurement record, which states what was executed to produce
            it. Latency figures are from a single instrumented call and a 33-generation sample on one day,
            so they are a shape rather than a benchmark.</td>
          </tr>
          <tr>
            <td>Framework overhead</td>
            <td>Stated as 84 ms here. Two earlier measurements on the same question read 46 ms and about
            79 ms on different dates, and no single reconciled figure exists.</td>
          </tr>
          <tr>
            <td>Memory share of the prompt</td>
            <td>Quoted as 35 percent of the system prompt including tool definitions. A 52 percent figure
            also appears in the source record against a narrower denominator.</td>
          </tr>
          <tr>
            <td>Barge-in telemetry on a live call</td>
            <td><b class="warn">Open.</b> Proven by tests and a diagnostic only.</td>
          </tr>
          <tr>
            <td>The long shutdown drain</td>
            <td><b class="warn">Open.</b> Needs a termination signal during a live call.</td>
          </tr>
          <tr>
            <td>Reasoning-effort as a latency lever</td>
            <td><b class="warn">Open, and explicitly a hypothesis.</b> The spans carry no attribute that
            would confirm or refute it.</td>
          </tr>
          <tr>
            <td>Library behaviour</td>
            <td>Read from the installed bundle at version 2.2.0, whose documentation comments are intact.
            A minor version could move any of it.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <footer>
    <p>Compiled <b>16 September 2026</b>. Sourced from the project's own verified findings record and from
    public product documentation only. No account identifiers, customer names or account-specific
    configuration appear on this page.</p>
    <p>Anything marked open above is an open item rather than an assumption. Where two measurements of the
    same quantity disagree, both are shown rather than averaged.</p>
  </footer>
</div>
