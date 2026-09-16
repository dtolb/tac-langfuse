  <!-- ============ 04 THE TOOLS COLLISION ============ -->
  <section id="tools">
    <h2><span class="num">04</span> <b>The tools collision</b> &middot; the SDK never invokes a tool, so the builder inherits dispatch</h2>

    <p class="lede-sm">Nine exported functions in the shipped Agent Connect bundle produce tools:
    <code>defineTool</code>, <code>createMemoryRetrievalTool</code>, <code>createMemoryTools</code>,
    <code>createSendMessageTool</code>, <code>createMessagingTools</code>, <code>createStudioHandoffTool</code>,
    <code>createKnowledgeSearchTool</code>, <code>createKnowledgeSearchToolAsync</code> and
    <code>createKnowledgeTools</code>. Alongside them the bundle exports the <code>TACTool</code> class and a
    <code>BuiltInTools</code> map.</p>

    <p class="lede-sm">Nine functions is not nine tools, which is why any count of them drifts. Three of the
    nine are factories of factories: the memory factory returns per-profile and per-session builders, the
    messaging factory returns a per-conversation builder, and the knowledge factory returns synchronous and
    asynchronous builders. <b>All of them collapse to the four canonical identities in that map</b>:
    <code>retrieve_profile_memory</code>, <code>send_message</code>, <code>handoff</code> and
    <code>search_knowledge</code>. Everything else is <code>defineTool</code>, the generic constructor for a
    tool of your own, which does no argument validation.</p>

    <p class="lede-sm">This scaffold adapts three of those nine functions today: the memory retrieval tool, the
    knowledge search tool and the handoff tool. It writes three more tools of its own in TypeScript, and its
    measured prompt carries five tool definitions on a voice turn, because voice retrieves memory automatically
    rather than through the retrieval tool. So the shim count is three, and four if the messaging tool is ever
    enabled to let the agent send a message mid-call. <b>That number is the same in every option below, and it
    does not change with the shape.</b></p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The detail that decides everything</p>
      <p>The SDK never invokes a tool. The implementation field is read in exactly two places in the whole
      bundle: assignment in the constructor, and the execute closure inside the adapter that converts a tool for
      one external agent SDK. The conversions for the two major model providers emit schema only. <b>Tool
      dispatch belongs entirely to the model runtime.</b></p>
      <p>So the moment the builder becomes the model runtime, every one of those tool objects is inert unless
      something re-exposes it. That is not a migration detail; it is the whole reason this section exists.</p>
    </div>

    <div class="wide tablewrap">
      <table class="wide-first" style="min-width:880px">
        <thead>
          <tr><th>Option</th><th>What actually moves</th><th>What it costs</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Re-expose the platform tools over HTTP or MCP</td>
            <td>The <code>TACTool</code> objects keep being constructed, each implementation is wrapped in a
            route in this process, and they are registered in the builder as OpenAPI or MCP tools. Definitions
            move; implementations stay in TypeScript.</td>
            <td>Three shims, four with messaging, a schema kept in two places, and one extra local hop inside
            the tool cycle. That hop is noise against a knowledge search measured at 417 ms to 1018 ms across a
            small single-day sample, and against a handoff measured once at 266 ms on one call, though a lookup
            that returned in about 1 ms would become dominated by it. <b>Requirement 3 is not satisfied for
            those tools</b>, which is the same limitation Dify's OpenAPI and MCP tools have, and which the MCP
            paths in Langflow and Flowise share.</td>
          </tr>
          <tr>
            <td>Split by ownership</td>
            <td>Platform tools stay behind the first option's surface with implementations in TypeScript. The
            business tools, the order-lookup and store-hours shaped things a non-engineer would actually add,
            are authored end to end inside the builder.</td>
            <td>Two authoring surfaces and an explanation of which is which. One thing makes the split cheaper
            than it looks: memory injection does not depend on any of the memory factories, because the SDK
            awaits memory retrieval before the prompt callback fires and voice retrieves once per conversation,
            so the memory block arrives on the prompt payload and can be passed to the builder as an input
            variable.</td>
          </tr>
          <tr>
            <td>Give up the SDK-native tools</td>
            <td>Knowledge search becomes a REST call to the Knowledge API authored as an HTTP tool in the
            builder, and handoff becomes a REST or TwiML action authored the same way. This genuinely moves the
            implementations into the builder.</td>
            <td>Reimplementing two platform integrations, owning their failure modes, losing whatever the SDK
            fixes upstream, and breaking the standing instruction not to route around the SDK. <b class="warn">It
            buys full compliance with requirement 3 at the price of the thing the scaffold exists to
            demonstrate.</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="lede-sm">The second option is the right trade, and the honest way to state it is that
    <b>requirement 3 is met for the tools a non-engineer would add and not met for the three platform
    ones</b>. The alternative is either a false claim or reimplementing the platform's own integrations to
    satisfy a rule.</p>
  </section>

  <!-- ============ 05 CHANNEL ASYMMETRY ============ -->
  <section id="channels">
    <h2><span class="num">05</span> <b>Channel asymmetry</b> &middot; requirement 2 is voice-only by construction</h2>

    <p class="lede-sm">The streaming argument rests entirely on <code>sendStreamingResponse</code>, which is a
    method on the voice channel. The messaging and chat path is a different callback, whose signature was read
    from the shipped bundle and returns <code>Promise&lt;string | null | void&gt;</code>. <b>There is no token
    sink in it, no writable, and no way to push a partial reply.</b> The SDK's own handler checks whether the
    returned value is a string and, if so, sends one frame with the final flag set.</p>

    <p class="lede-sm">That is exactly the one-string-per-turn shape used to eliminate a candidate whose own
    documentation says streaming is planned and not implemented. Which means the inverse holds too: a runtime
    that cannot stream a token is indifferent on messaging and chat, and every candidate that fails requirement
    2 becomes eligible on those channels.</p>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">Two smaller differences follow from the same signatures, and both matter</p>
      <ul>
        <li>The abort signal is required on the voice prompt payload and optional on the messaging callback, so
        the abort-forwarding mitigation in section 02 covers voice only.</li>
        <li>The memory field is named differently on the two payloads, so code that reads the voice spelling
        reads undefined on the other half of the scaffold.</li>
      </ul>
    </div>

    <div class="wide tablewrap">
      <table style="min-width:620px">
        <thead>
          <tr><th>Requirement</th><th>Voice</th><th>Messaging and browser chat</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>1 &middot; Self-hosted open source</td>
            <td>Applies</td>
            <td>Applies. The licence and the container stack do not care what a turn arrives on</td>
          </tr>
          <tr>
            <td>2 &middot; Token streaming</td>
            <td>Applies</td>
            <td><b>Does not apply.</b> The callback returns one finished string</td>
          </tr>
          <tr>
            <td>3 &middot; In-builder tools</td>
            <td>Applies</td>
            <td>Applies. A tool is a tool</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="lede-sm">That asymmetry is load-bearing for the recommendation, because it means a candidate can
    be disqualified for voice and remain the best answer for the other two channels. Section 07 names the
    candidate it creates a position for, so that it is a decision rather than something discovered by accident
    later.</p>
  </section>
