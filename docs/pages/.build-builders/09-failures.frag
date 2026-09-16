  <!-- ============ 06 FAILURE MODES ============ -->
  <section id="failures">
    <h2><span class="num">06</span> <b>Five failure modes</b> &middot; the first one changed the recommendation</h2>

    <p class="lede-sm">The first of these dwarfs everything section 02 spends a paragraph defending, and it is
    the reason the recommendation is what it is. None of the five is a latency argument in the network sense, and
    four of them are invisible in a chat window.</p>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Provider prompt
    caching depends on a byte-identical prefix</h3>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The measured gap between a cold and a warm cache, with its caveats attached</p>
      <p>On one measured call the first turn's first generation took 3838 ms to first chunk against a cold
      cache, on a two-generation tool-calling turn with roughly 2520 input tokens. The following turns on that
      same call reported cached input tokens and ran 0.51 s to 0.71 s. <b>Those warm figures are turn two onward
      on a single call with one caller and one model, and they mean nothing quoted without that qualifier.</b>
      Span durations do not sum to that cold turn either, because the tool fires as soon as its arguments parse
      and overlaps the first generation.</p>
      <p>The gap between those two states is a multi-second regression on the turn a caller forms an impression
      on. <b class="warn">A builder that rebuilds the system prompt per run, reorders tool definitions or
      injects a run identifier into the prefix turns every turn into that cold turn.</b></p>
    </div>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:880px">
        <thead>
          <tr><th>Candidate</th><th>Prefix behaviour</th><th>Mechanism</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Coze Studio breaks it, and it cannot be configured away</td>
            <td>The cache never hits, so every turn is a cold turn.</td>
            <td>Its reasoning system prompt has, as its third line before anything cacheable, a sentence stating
            the current time, filled per run at second resolution. That is a compile-time constant in Go, so
            removing it means forking the project and rebuilding the image. The same template also inlines
            retrieved knowledge chunks into the system message, so even with the timestamp patched the prefix
            churns whenever retrieval returns something different.</td>
          </tr>
          <tr>
            <td>VoltAgent breaks it whenever a retriever is attached</td>
            <td>The prefix changes on every turn.</td>
            <td>It appends a context block derived from the current user utterance to the end of the system
            prompt on every turn. That is structurally the same failure this scaffold's own uncapped memory
            block already walked into, and an explicit cache-breakpoint option is the documented
            mitigation.</td>
          </tr>
          <tr>
            <td>Windmill handles it deliberately</td>
            <td>Byte-stable by explicit design.</td>
            <td>The system prompt is the step's configured message verbatim, and its cache key is derived from
            the workspace, the runnable path and the step id, with a source comment stating that keying on the
            step rather than the run is deliberate.</td>
          </tr>
          <tr>
            <td>Sim engineers it</td>
            <td>Stable, with breakpoints placed on purpose.</td>
            <td>Cache-control breakpoints are placed on the last system block and the last tool definition, and
            its cache key is a hash of the workflow and block ids.</td>
          </tr>
          <tr>
            <td>Mastra treats it as a first-class design goal</td>
            <td>Stable by design, with the two ways to break it documented.</td>
            <td>Cache preservation is documented as a goal across four separate pages, and it names the two ways
            to break it: a sliding message window that changes the start of the prompt as a thread grows, and
            working memory living in the system prompt. Each carries a documented fix, and both are traps this
            scaffold already fell into.</td>
          </tr>
          <tr>
            <td>Node-RED comes out well by doing nothing at all</td>
            <td>Whatever the flow author makes it.</td>
            <td>The request body is read verbatim from a message property with no wrapper and no reordering, so
            stability becomes entirely the flow author's responsibility, with no guard rail either way.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Conversation history
    drifts, and barge-in is the trigger</h3>

    <p class="lede-sm">Most candidates own the transcript, keyed by an identifier of their own, and re-send a
    window per turn. That is fine until a turn ends differently on the two sides. <b>The concrete drift trigger
    for voice is barge-in: a turn this side truncates locally is still whatever the builder persisted
    server-side, and the model reads the builder's copy on the next turn.</b> Pick one owner, make the other side
    advisory, and never run both alongside the SDK's own recall.</p>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Who owns the transcript, and whether you can take it back</p>
      <ul>
        <li><strong>Mastra</strong> keys threads by its own thread and resource identifiers and re-sends a
        window per turn.</li>
        <li><strong>Coze Studio</strong> keys by its own conversation identifier, re-assembles up to a default
        of one hundred rounds per turn, and has no flag to run statelessly, so <b class="warn">it cannot be
        driven from this side's transcript at all.</b></li>
        <li><strong>Windmill</strong> keys by its own memory identifier and re-reads from its database per turn,
        with a manual-messages mode as a clean escape.</li>
        <li><strong>Sim</strong> owns history in its own store but keyed by an identifier the caller supplies,
        so there is only ever one copy.</li>
        <li><strong>VoltAgent</strong> owns it keyed by its own identifiers, with persistence suppressible per
        call.</li>
        <li><strong>Node-RED</strong> owns nothing, because it has no memory abstraction.</li>
      </ul>
    </div>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Concurrency is unmeasured for every candidate, and two have a named mechanism worth pricing</p>
      <p>Windmill inserts one new database row per stream event, on the same database that runs its job queue,
      with a 20 s write timeout that logs and breaks. That truncates the answer mid-sentence with no
      client-visible signal. Coze Studio puts eleven containers in the request path, including a vector store, a
      coordination service, an object store and a three-process queue cluster, against three containers today.
      Sim's container definition gives the application an 8 GB memory limit, and its behaviour under
      simultaneous calls was not tested.</p>
      <p>A demonstration with two simultaneous calls is a plausible demonstration, and <b>nobody has a figure
      for it.</b></p>
    </div>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Text destined for speech synthesis, which is easy to overlook because it reads fine in a chat window</p>
      <p>ConversationRelay synthesises whatever arrives in the token string. Markdown, emoji and bullet lists
      arrive intact. SSML passes through, but with the default synthesis provider only one element is honoured
      and only for one language. Nothing in the protocol strips anything.</p>
      <p>Stripping it in the bridge splits into two very different implementations. A character filter that drops
      emoji and stray punctuation can run per chunk with no lookahead and costs nothing. A real markdown parser
      needs lookahead across chunk boundaries and therefore re-buffers, <b class="warn">which defeats requirement
      2 to fix a cosmetic problem.</b> Prefer the character filter, and prefer prompting against markdown in the
      first place. One candidate makes this worse by default: Coze Studio emits reasoning deltas as delta frames
      on the same stream sharing the answer message's identifier, so a naive consumer synthesises the model's
      chain of thought to the caller.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The repository's own
    guard suite, which the first pass did not account for anywhere</h3>

    <p class="lede-sm">Five vendor-boundary rules are enforced by a test that reads import strings across the
    server, shared and web trees, and separate tests assert that no logging bypasses the scrubbing hook, that the
    shared directory imports nothing outside itself, that every environment variable read appears in the example
    file, and that the container definition lists every path prefix as a literal. Above those sit tripwires that
    assert the rule set is intact, <b>because the failure mode of a guard is not a false alarm, it is passing
    silently forever.</b></p>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:800px">
        <thead>
          <tr><th>Guard</th><th>What the move does to it</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>The two rules confining the model SDK and its provider package to one directory</td>
            <td>They stop describing anything once the builder is the thing that calls the model. A builder that
            is itself a wrapper around the same model SDK means the rule has to be <b>rewritten to name the
            builder's package rather than deleted</b>, and the tripwire's minimum count adjusted deliberately
            rather than lowered to make a test pass.</td>
          </tr>
          <tr>
            <td>The rule confining the trace client to the prompt directory</td>
            <td>It survives only if the incumbent prompt service stays. A builder that retires that service
            retires the rule with it.</td>
          </tr>
          <tr>
            <td>The two rules keeping the Twilio packages inside the adapter directory</td>
            <td>Untouched in every shape, because the channel seam does not move. That is the one piece of good
            news in this section.</td>
          </tr>
          <tr>
            <td>The Twilio-free bench, which is not a test</td>
            <td>Shape (b) adds a loss no assertion catches: the bench exercises the turn function end to end in
            this process, so moving the model out <b class="warn">moves the thing being proved out of the process
            the bench runs in.</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
