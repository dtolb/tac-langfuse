  <!-- ============ 04 UPSTREAM ============ -->
  <section id="upstream">
    <h2><span class="num">04</span> <b>Does this belong upstream</b> &middot; and what the join costs</h2>

    <p class="lede-sm">Yes, and the argument does not require the maintainers to adopt an observability
    opinion.</p>

    <p class="lede-sm">Every span in this design is reconstructed from the outside, out of four callback
    entry instants plus the resolution of one streaming method. That reconstruction exists for one
    structural reason: the library dispatches consumer callbacks with no trace context attached. The shipped
    2.2.0 bundle contains zero occurrences of <code>opentelemetry</code> in either its JavaScript or its
    type declarations, and its total self-reported timing surface is three items, none of which is a
    duration it measured of itself. The interrupt callback in particular is dispatched straight from the
    WebSocket message handler, which is why a barge-in roots its own trace unless the consumer parents it
    explicitly by a span context captured earlier.</p>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">The smallest change that would remove the need for wrapping</p>
      <p>A dependency on <code>@opentelemetry/api</code> alone, with one internal span per inbound prompt
      and per interrupt, and the corresponding callbacks dispatched inside that span's active context. The
      API package is designed for exactly this: with no SDK registered in the host application it returns
      non-recording spans, so a library can create them unconditionally at effectively no cost and with no
      opinion about exporters.</p>
      <p>Consumers would then get nesting instead of reconstruction, the interrupt callback would stop
      rooting its own trace, and per-turn boundaries would become observable without anyone reading the
      bundle to learn that prompts are serialised through a private promise chain. A slightly larger version
      of the same change would also close the playback gap by widening the inbound message union so that
      TwiML-subscribed playback and speaker events reach a handler instead of a dropped-frame debug log.</p>
    </div>

    <p class="lede-sm">The honest counterweight is that the surface this design already leans on carries no
    stability guarantee. The callback types are exported and are not tagged internal, and the project's own
    conventions treat the internal tag as the marker for members consumers should not call, so not being
    tagged is a deliberate signal. Version discipline exists in practice; the keypad-digit addition reasons
    in semantic-versioning terms in its own release note. But no written policy backs any of it. Grepping
    the contributing guide, the readme and the development guide for stability, semantic versioning,
    breaking changes, public API or deprecation language turns up nothing on the subject, and no
    <code>@public</code>, <code>@stable</code> or <code>@experimental</code> tags are in use. The published
    API reference the readme points at returns 404 and serves an organisation-wide redirect stub, which is
    <a href="https://github.com/twilio/twilio-agent-connect-typescript/issues/93">an open issue</a>, so a
    reader cannot even check what the reference claims. Building on these hooks is a reasonable bet on
    intentionally exported surface, not an integration against a contract.</p>

    <div class="wide tablewrap">
      <table style="min-width:700px">
        <thead>
          <tr><th>Maintenance signal</th><th>What was observed</th><th>How to read it</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Repository</td>
            <td><a href="https://github.com/twilio/twilio-agent-connect-typescript">Public, MIT licensed,
            created January 2026</a>, 14 stars and 9 forks at the time of reading.</td>
            <td>Young and small. Nothing here is a long-lived API by age.</td>
          </tr>
          <tr>
            <td>Release cadence</td>
            <td>2.0.0 within about two months of 1.0.0, and 2.3.0 in its fifth month.</td>
            <td>Fast majors. A wrapper should expect to be revisited per major.</td>
          </tr>
          <tr>
            <td>Commit shape</td>
            <td>Roughly twenty non-dependabot commits across two and a half months, clustered on release
            days, from effectively two maintainers plus one occasional contributor.</td>
            <td>Active but bursty. Sixteen pull requests are open, about half from automated dependency
            tooling.</td>
          </tr>
          <tr>
            <td>Issue history</td>
            <td>Discussions disabled, no roadmap, no changelog, and only three issues ever filed, all
            documentation nits.</td>
            <td>A search across issues and pull requests for OpenTelemetry, tracing, metrics, spans and two
            tracing vendor names returns zero hits, but in a three-issue repository that is close to no
            signal at all. <b class="warn">Absence of demand is not evidence of a decision against.</b></td>
          </tr>
          <tr>
            <td>Product analytics pull request</td>
            <td><a href="https://github.com/twilio/twilio-agent-connect-typescript/pull/95">One open pull
            request</a> adds vendor-facing analytics emitting conversation and websocket lifecycle events,
            with an opt-out environment variable. Its emit functions are exported but tagged internal.</td>
            <td>An explicit statement that they are not a consumer extension point. The one thing in it that
            would reach a subclass is the messaging send path refactored into a template method.</td>
          </tr>
          <tr>
            <td>A private staging repository</td>
            <td>Its public description says it holds a voice-provider foundation and a live-model port, and
            that it merges into the public TypeScript SDK.</td>
            <td>That is precisely the path this tracing design wraps, which makes the voice-specific parts of
            any wrapper the least safe thing to depend on. The claim rests on a name and a description
            only.</td>
          </tr>
          <tr>
            <td>Observed version drift</td>
            <td>2.2.0 to 2.3.0 was one additive pull request adding a keypad-digit callback, plus a
            behaviour-preserving extraction of the conversation-initialisation block. Nothing on the prompt
            path changed.</td>
            <td>Reassuring by comparison. A 2.2.0-shaped design still holds at 2.3.0. In 2.2.0 keypad
            digits fail inbound validation and are dropped with a debug log.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">The join to the
    companion page</h3>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The most useful instrument here is the one that leaves with the model call</p>
      <p>The single instrument that turns the question of whether it is us or the model into one query rather
      than an investigation is emitted by the model SDK running inside this process. A grep of the shipped
      Agent Connect bundle for <code>@opentelemetry</code>, <code>AsyncLocalStorage</code>,
      <code>trace.getTracer</code> and <code>traceparent</code> returns nothing, so every generation span and
      every <code>gen_ai.*</code> attribute on it, including the time-to-first-chunk value, comes from the
      model SDK's telemetry integration registered here at process start.</p>
      <p>Move the model call out into a separate agent runtime and that instrument leaves with it. Unless the
      replacement runtime accepts a W3C <code>traceparent</code> on its streaming request and continues the
      trace, one trace covering a whole call becomes two trees with no shared identifier, and the number both
      of these pages lean on is produced by a library that no longer runs where the spans are assembled.
      <b class="warn">Whether any of the candidate agent builders propagates an inbound
      <code>traceparent</code> is an open question</b> and is not settled anywhere in this work.</p>
      <p>The companion page in this pair, on replacing the agent core with a visual agent builder, is where
      that trade is argued:
      <a href="https://pages-4296.twil.io/tac-agent-builder-options">tac-agent-builder-options</a>. Read this
      section first, because it is the cost side of that decision and it is easy to discover afterwards
      instead.</p>
    </div>
  </section>
