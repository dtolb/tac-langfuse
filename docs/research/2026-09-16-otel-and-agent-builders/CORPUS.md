# Published page boundary and reusable assets

# 1. Section inventory, per page

## A. `/agent-scaffold-architecture` — `/Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html`

Live and byte-identical to local (`curl` → 200, 101 425 bytes, matches `wc -c`). **Not in `docs/.twilio-pages.json`** — that manifest lists only `scaffold-next-steps`, so the manifest is out of date relative to what is actually served.

Title: *"Voice and SMS AI agent scaffold: architecture, turn anatomy, and what the traces proved"*. Eyebrow: `ConversationRelay · Conversation Orchestrator · OpenTelemetry`. H1: *"One agent, three channels, every turn traced"*.

Eight numbered sections, each `<section id=…>`:

| id | heading (verbatim) |
|---|---|
| `#architecture` | `01 System architecture · select a node` |
| `#turn` | `02 Anatomy of a turn · select any hop` — sub-blocks `A · The turn itself`, `B · After the last turn` |
| `#numbers` | `03 Where the time goes · measured, with caveats` |
| `#tac` | `04 Working with the Agent Connect library · assumption against reality` — `A · Boot and wiring`, `B · What it does not do, so you must`, `C · Memory, and the shape of the tools` |
| `#otel` | `05 Instrumenting it with OpenTelemetry · what silently produced nothing` — `A · The export pipeline`, `B · Linking and nesting` |
| `#proven` | `06 What is proven, and what is not` — cards `Proven on real traffic`, `Not exercised yet`, `Debt taken on purpose` |
| `#rules` | `07 Rules worth carrying to the next build` |
| `#verification` | `08 Verification and open items` |

Ground already covered, in full:
- **ConversationRelay**: `reportInputDuringAgentSpeech` defaulting to `none` since May 2025; barge-in interrupt semantics; the `last:true` end marker only firing if ≥1 token was sent; queued audio draining 1.75 s past socket close; no first-byte-of-audio or end-of-playback exposure.
- **Conversation Orchestrator**: SMS arrives via status callback + bidirectional capture rules in an *event envelope*, not a form post; extraction is post-conversation only; close latency 5 m 36 s ordinary vs 32 s after handoff; ~2 s from close to observation.
- **TAC v2.2.0, 18 assumption/reality rows** across three tables (§04) — registration order, constructor network call, `preprocess`-wrapped required-but-valueless keys, `start()` owning `listen`, prompt builder having zero internal callers, no end-session method, empty reply = silent no-reply, global (not per-channel) message-ready slot, callback route can't double as call-action URL, memory-mode semantics, recall-failure fallback, catalog≠offered tools, one branching handoff tool, default handoff description. Plus the shutdown callout: 10 s watchdog vs 30 s WS drain vs pre-close hook ordering.
- **OpenTelemetry, 12 assumption/reality rows** (§05) — span-processor type filters silently dropping spans, custom attributes needing to nest under `metadata`, the proxy provider with no `flush`, truthiness-guard serializer dropping `null`, close-before-flush ordering, stale container image; then nesting: `startObservation` not making the span active, the prompt link riding runtime context (not telemetry metadata) and requiring a numeric version, prompt link computed only for GENERATION observations, gen-AI span-name convention, in-memory exporter can't exercise the real processor, and 404 = read API disabled.
- **The measured latency table** (§03), 12 rows with a caveat column, plus two callouts: the prompt-share breakdown (33 % base / 35 % memory / 32 % tools) and the two ClickHouse-answerable queries (`host.name`, memory chars).
- **The span tree** as a `<pre>` ASCII diagram (`conversation` → `caller.turn` / `turn.voice` → `prompt.fetch`, `memory.recall`, `prompt.compose`, `tool.selection`, `llm.stream`, `invoke_agent`, `tts.send`).
- **PII callout**: "Say this accurately: the traces contain personal data."

## B. `/Users/dtolbert/code/tac-langfuse/docs/scaffold-next-steps.html` (live at `/scaffold-next-steps`)

**Stale.** Its eyebrow reads `Demo scaffold · after T11` and its "Where things stand" table says *"SMS channel — Not built yet (T12)"*, *"Voice / ConversationRelay — Not built yet (T13)"*, *"Twilio built-in tools (handoff, knowledge) — Not built yet (T14)"*, *"Docker / Traefik deploy — Not built yet (T15–T17)"*. All of those shipped. It also warns *"Setting the Twilio variables today will not make voice or SMS work"* — now false.

Headings: `What to do next` (h1); `Where things stand`; `Two containers, one public host, split by path`; `One bench turn, hop by hop`; then numbered operator steps `1 Start everything`, `2 Open the bench and send two messages`, `3 Read the footnote under each answer`, `4 Find the trace in Langfuse`; env groups `Group 1 — the core five. All of them, or no channel starts at all.`, `Group 2 — voice`, `Group 3 — orchestrated mode (required for SMS, memory, handoff, knowledge)`; then credential verification `1 Confirm the CLI is using the credentials you think it is` … `6 Then check the scaffold agrees`.

Unique ground worth *not* duplicating: the three env-var groups, the six-step independent credential verification (auth token vs API key/secret), and the Traefik path-split container diagram. Everything else it says about state is superseded.

## C. `/convo-vs-livekit` — `~/code/pages/convo-vs-livekit.html`

Internal competitive dossier, `flight-sandbox "Delta Assist"`, dated 2026-07-20. H1: *"Same demo, two architectures — and they aren't the same product."*

| # | heading |
|---|---|
| 01 | `The two architectures, drawn by ownership` (two SVGs, colour = who *runs* the box) |
| 02 | `Product-by-product: what maps, what doesn't` (10-row table, verdict column LK win / DIY / TW win / Split) |
| 03 | `The honest ledger` — `What LiveKit genuinely gives them` / `What they give up — and now own` |
| 04 | `Per-minute economics of the LiveKit stack` — `Cascaded voice-agent minute, as researched for this repo` |
| 05 | `Selling against LiveKit — five plays` — `"LiveKit replaces Twilio" is false — even in their docs`, `The conversation layer becomes their backlog`, `Don't bluff on audio — pivot on it`, `Demo the thing they cannot do`, `Platform fees are noise; ops and models are the bill`, `Know our own soft spots before they raise them` |

Covers ConversationRelay as a *capability boundary* (managed, config-at-TwiML-time, no mid-call model swap, no raw audio, built-in `prompt`/`interrupt` not tunable), Orchestrator `GROUP_BY_PROFILE` passive capture, Conversation Memory phone→profile + Recall, Intelligence v3 operators. No OTEL-instrumentation ground and no TAC-SDK-internals ground beyond "TAC SDK maturity (1.0.x, rough edges this repo hit)".

## D. `~/code/pages/tac-payment-reminder-walkthrough.html` (live at `/tac-payment-reminder-walkthrough`)

Title *"TAC payment reminder: architecture and call flow"*, eyebrow `Build walkthrough · Twilio Agent Connect`, H1 *"An AI agent that calls, answers, texts, and hands off"*. **Python + OpenAI Agents SDK, outbound-initiated** — a different build from the tac-langfuse scaffold (Node/TS, AI SDK, inbound), so overlap is idiomatic more than factual.

Headings: `System architecture · select a node` (7 nodes: `console`, `app`, `model`, `voice`, `know`, `conv`, `sms`); `Call flow · select any hop` with `A · Dial and converse` / `B · Tools, handoff, and feed` (18 hops, titles 01 `Provision once` → 18 `Everything streams to the console`); `The three tools · what the model is allowed to do` (`Answer from policy` / `Text a tracked link` / `Escalate to a human`); `Design rules · four constraints that shaped the agent`; `One call, two far ends · the leg from hop 03 never drops`; `Running on another model · two paths to Gemini`; `Reference · docs for the platforms, and the files in the repo`; `Verification and open items`.

Already-covered TAC ground: relay session ending while the call stays up and Twilio asking the app what to do next on *every* relay ending; the built-in handoff tool's Studio path returning 400 for an outbound call; per-conversation tool binding because injection mutates in place; voice and text needing separate agents/prompts; explicit consent for the SMS tool.

## E. `~/code/pages/Agent-Connect-Implementation-Guide.html` (live at `/agent-connect-implementation-guide`)

Seven interactive slides, dark theme, Python/TypeScript toggle. Headings: `01 What Agent Connect does` → *"Middleware between your LLM and Twilio channels"*; `02 Key decisions before you build` → *"Three choices. One requirements panel."*; `03 Setup sequence` → *"Six steps from zero to running server"*; `04 First agent — Voice` → *"Inbound call → AI response in under 1s"*; `05 Adding Conversation Memory` → *"One env var. One parameter. Instant context."*; `06 Add SMS · Swap providers` → *"Two more channels. Any model. Same agent."*; `07 Production checklist` → *"Before you go live"* (six click-to-tick items incl. debug mode and webhook signature validation).

This is the **getting-started / happy-path** page. It asserts memory is "one env var, one parameter" and that SMS is "five lines different from Voice" — both of which §04 of agent-scaffold-architecture materially qualifies. A new page should treat that tension explicitly rather than restate either side.

---

# 2. DO-NOT-DUPLICATE list

Link, don't restate. Anchors below are real `id`s on the live pages except where noted as heading text only.

**To `https://pages-4296.twil.io/agent-scaffold-architecture`:**

| Don't restate | Link to |
|---|---|
| The nine-node clickable topology and any redraw of adapter/core/front-door layering | `#architecture` |
| Any 10–15-hop turn walkthrough; individually deep-linkable | `#turn`, and `#hop-01` … `#hop-15` (the `openFromHash` handler opens and scrolls a hop) |
| The 12-row latency table (84 ms framework, 3838 ms cold, 586–801 ms tool-free, 1282–1433 ms tool turn, 417–1018 ms knowledge search, 2394 ms trailing audio, the 2–5× upstream slow window) | `#numbers` |
| The prompt-share breakdown and the memory-block growth series 2341 → 1837 → 3303 → 4412 chars | callout `The lever that is actually top of the list` inside `#numbers` |
| The `conversation` / `caller.turn` / `turn.voice` span-tree ASCII diagram | the `<pre>` immediately under the `#otel` h2 |
| All 18 TAC assumption/reality/symptom rows | `#tac` (`A · Boot and wiring`, `B · What it does not do, so you must`, `C · Memory, and the shape of the tools`) |
| The three-timeout shutdown story (10 s watchdog / 30 s WS drain / pre-close hook) | callout `Shutdown is where three timeouts disagree` in `#tac` |
| All 12 OTEL assumption/reality/symptom rows, incl. the span-processor filter finding and the proxy-provider flush | `#otel` |
| The PII statement | callout `Say this accurately: the traces contain personal data` in `#otel` |
| Proven / not-exercised / deliberate-debt inventory | `#proven` |
| The eight transferable rules and the two test-method traps | `#rules` |
| Number provenance and the 84 vs 46 vs 79 ms and 35 % vs 52 % disagreements | `#verification` |

**To `/convo-vs-livekit`** — the 10-row capability table (heading `Product-by-product: what maps, what doesn't`), the two ownership diagrams (`The two architectures, drawn by ownership`), the ~$0.014-of-$0.23 minute economics (`Per-minute economics of the LiveKit stack`), and the give-up ledger (`What they give up — and now own`).

**To `/tac-payment-reminder-walkthrough`** — the three-tool anatomy (`The three tools · what the model is allowed to do`), the four design rules (`Design rules · four constraints that shaped the agent`), the relay-ends-call-persists diagram (`One call, two far ends · the leg from hop 03 never drops`), and the model-swap table (`Running on another model · two paths to Gemini`).

**To `/agent-connect-implementation-guide`** — the setup sequence (`Six steps from zero to running server`), memory before/after (`One env var. One parameter. Instant context.`), the SMS diff (`Two more channels. Any model. Same agent.`), and the production checklist (`Before you go live`).

**Do NOT link to `/scaffold-next-steps` for state.** Its status table is pre-T12. Link it only for the env-var groups and the six-step credential verification, and say what it is.

---

# 3. What `/convo-vs-livekit` already concludes about replacing the relay layer

An agent-builder page can cite these instead of re-arguing:

1. **The frame:** "LiveKit sells media infrastructure with an agent framework on top. Twilio Agent Connect sells a managed conversation layer around your brain… everything above the audio — threading, memory, post-call intelligence, and all of messaging — simply does not exist on the LiveKit side."
2. **Replacing the relay does not remove Twilio.** "LiveKit's telephony quickstart is literally 'connect your Twilio Elastic SIP trunk.' Their native numbers are inbound-only with no SMS and no porting." Verdict on PSTN: `TW win — Twilio stays in every LiveKit deployment.`
3. **The media-layer concession is already made, in writing.** ConversationRelay = `LK win Genuine. Don't bluff on audio control.` Turn detection/barge-in = `LK win Their strongest technical talking point.` So a builder page does not need to defend the relay's audio control.
4. **The counted cost:** headline metrics `4 → 0` vendor-run conversation services and `4 → 9` customer-operated subsystems, plus `+1 New always-on runtime`. Threading, memory, session-end detection and post-call classification become "five engineering projects (SMS session-end is a policy Orchestrator ran silently)."
5. **Cost shape:** "LiveKit itself is ~$0.014 of a ~$0.23 minute… ~90% of a voice minute is model vendors either way, and TTS choice dominates." The change is headcount-shaped, not per-minute.
6. **Named own soft spots:** ConversationRelay's fixed pipeline (no mid-call model swap, no raw audio), no browser-voice story in that stack, TAC SDK maturity, Intelligence v3 PCI/HIPAA ineligibility.

Caveat to carry: that page's own footer says the adversarial verification pass was rate-limited and **25 claims including every price are sourced but unverified**, researched July 2026. Cite the architecture conclusions freely; re-check any number.

---

# 4. Reusable assets in `agent-scaffold-architecture.html`

**Best handle: the fragment directory.** The page was assembled from `/Users/dtolbert/code/tac-langfuse/docs/pages/.build/` — concatenating `01-head.frag` + favicon + `03-style.frag` + `04-…` … + `10-close.frag` reproduces it. Extract from these, not from offsets, where possible.

| Fragment | Bytes | Contents |
|---|---|---|
| `01-head.frag` | 470 | doctype through `<meta name="description">`; ends *before* the favicon link |
| `favicon.frag` | 37 | **placeholder only**: `<link rel="icon" href="placeholder">`. The real 20 KB data URI exists only in the emitted HTML |
| `03-style.frag` | 12 234 | the entire `<style>` block |
| `04-masthead-topology.frag` | 15 836 | `<header>` + `<section id="architecture">` incl. the SVG and all nine node panels |
| `05-ladder.frag` | 18 026 | `<section id="turn">`, both ladders, hops 01–15 |
| `06-numbers.frag` | 5 309 | `<section id="numbers">` |
| `07-tac.frag` | 9 285 | `<section id="tac">` |
| `08-otel.frag` | 7 890 | `<section id="otel">` incl. the span-tree `<pre>` |
| `09-limits.frag` | 9 761 | `#proven` + `#rules` + `#verification` + **the `<footer>`** + closing `</div>` |
| `10-close.frag` | 2 443 | the whole `<script>` + `</body></html>` |

**Byte offsets into `agent-scaffold-architecture.html` (101 425 bytes total), zero-indexed, inclusive:**

- **Favicon data-URI link** — bytes `470`–`20640` (line 8, 20 171 bytes). Single line, `<link rel="icon" href="data:image/x-icon;base64,AAABAAMAMDAAAAEAIACoJQAA…">`. Contains three icon sizes (48/32/16). Copy the whole line verbatim.
- **Inline `<style>` block** — bytes `20641`–`32840` (lines 9–279, 12 200 bytes), delimited by `<style>` at 20641 and `</style>` at 32832. Structure: `:root` custom properties, resets, `/* hero */`, topology, ladder, detail panels, cards, callouts, tables, then `@media (max-width:820px)` (line 177 of the fragment — collapses the ladder to a plain list by hiding `.lanes,.rails` and `.row::before/::after`), `@media (max-width:600px)`, and `@media (prefers-reduced-motion:reduce)`.
- **Clickable-topology SVG** — bytes `34621`–`41262` (lines 316–438, 6 642 bytes), from `<svg viewBox="0 0 1200 520" role="img" aria-label="Topology: …">` to `</svg>`. Enclosed by `<div class="topo">`. Machinery: one `<marker id="ah">` arrowhead def; `<rect class="gbox">` + `<text class="glabel">` for the "This repo" grouping box; `<path class="edge">` / `.edge.dash` with `<text class="elabel">`; each clickable node is `<g class="node" data-node="…" role="button" tabindex="0" aria-expanded="false" aria-controls="n-…" aria-label="…">` containing a `<rect>` with `stroke="var(--plat|--app|--obs|--neutral)"` plus `.nlabel`/`.nsub` text. Non-clickable caller boxes are bare `<g>` with no `data-node`. Panels follow the SVG as `<div class="node-detail detail" id="n-…" style="--acc:var(--plat)" hidden>` wrapping a `<dl>` with the fixed rubric `What` / `Why here` / `Talks to` / `Constraint`. Full section `#architecture` = bytes `33968`–`48710`.
- **Sequence-ladder machinery** — section `#turn`, bytes `48769`–`66736` (lines 560–841). Per-ladder shape: `<div class="lanes" aria-hidden="true">` with five `.lane` chips → `<div class="ladder">` → `<div class="rails" aria-hidden="true">` with five `<i style="left:10%|30%|50%|70%|90%">` → optional `<span class="spanmark"><i></i><em>caller.turn spans the gap</em></span>` (needs the enclosing `<div class="spanwrap">`) → N× `<div class="step" id="hop-NN" style="--acc:var(--plat)">` each containing `<button class="row" aria-expanded="false" aria-controls="dNN" data-dir="r|l|b" style="--from:50%;--to:70%">` and `<div class="detail" id="dNN" hidden>` with `<p class="what">` then one or more `<p class="why">`. The arrow is pure CSS: `.row::before` draws the line from `--from` to `--to`; `.row::after` becomes a left- or right-pointing triangle based on `data-dir` (`b` = both, using the extra `.head2` span). Expand/collapse-all buttons live in the h2: `<button data-bulk="open" data-scope="#turn">`.
- **The `<script>`** — bytes `98982`–`101408` (lines 1445–1512, 2 427 bytes), plain ES5, no dependencies, ~68 lines. Five parts: `panelFor(el)` resolving `aria-controls`; `toggleStep(row, force)`; `toggleNode(node)` enforcing one-panel-at-a-time by clearing every `.node` and `.node-detail` first; one delegated `click` listener handling `[data-bulk]`, `.row`, `.node` in that order; keyboard `Enter`/`Space`/`Spacebar` on `.node`; and `openFromHash(scroll)` wired to `hashchange` and called on load, which is what makes `#hop-NN` deep links work. Copy it whole — it drives both the topology and the ladders.
- **Footer shape** — bytes `98528`–`98974` (lines 1437–1443, 447 bytes). Two `<p>` only, no headings, no links, inside the page's outer `<div class="wrap">`. Para 1: compiled date in `<b>`, provenance ("the project's own verified findings record and… public product documentation only"), and an explicit leak disclaimer ("No account identifiers, customer names or account-specific configuration appear on this page."). Para 2: the two reading rules — "anything marked open above is an open item rather than an assumption" and "where two measurements of the same quantity disagree, both are shown rather than averaged." Sibling pages should keep this two-paragraph shape and swap the date.

Reusable CSS class vocabulary worth matching by name: `.wrap`, `.eyebrow`, `.thesis`, `.facts`/`.fact`, `.lede-sm`, `.legend`, `.topo`, `.hint`, `.lblock`, `.lanes`/`.lane`/`.dot`, `.ladder`/`.rails`/`.spanwrap`/`.spanmark`, `.step`/`.row`/`.wlabel`/`.chev`, `.detail`/`.what`/`.why`, `.node-detail`, `.cards`/`.card`/`.api`/`.when`, `.callout`/`.dtitle`, `.tablewrap`, `table.wide-first`, `.num`, `.bulk`, `b.warn`.

---

# 5. The accent variant

**It is not one of the three — the page uses all three at once as a semantic trio, plus a neutral.** From `:root` in `03-style.frag`, with the source comment intact:

```
/* Semantic trio. Blue is the Twilio platform, magenta is the code in this repo,
   green is observability. Callers and the model provider stay neutral grey so the
   three accents keep meaning. */
--plat:#2E6FA3;     /* Twilio platform  — ConversationRelay, Orchestrator, Studio, Memory/Knowledge */
--app:#C42B72;      /* this repo        — adapter layer, browser bench, agent core */
--obs:#2E7D5B;      /* observability    — Langfuse, telemetry hops, "proven" card */
--neutral:#5A6B7A;  /* caller or model provider — deliberately not an accent */
```

Supporting neutrals a sibling must match: `--field:#ECF1F3` (page background), `--paper:#FFFFFF`, `--ink:#14283A`, `--muted:#5A6B7A`, `--line:#C6D2D9`, `--edge:#A8B7C0`, code block `--code:#0E1B27` / `--codeink:#D8E4EC` / `--codemuted:#6E879A`. Fonts: `--display` Avenir Next stack, `--body` Helvetica Neue stack, `--mono` SF Mono stack. The body carries an 80 px graph-paper grid built from two `repeating-linear-gradient`s at `rgba(46,111,163,.06)` — i.e. the grid is tinted with `--plat`.

How the trio is applied, so siblings stay legible: `--plat` on the eyebrow text and on platform-owned SVG strokes; per-block accent via an inline `style="--acc:var(--…)"` on `.step`, `.node-detail`, `.card` and `.callout` (never a class); `b.warn` for the "never quote this" warnings. Section-number `.num` and `h2 b` follow the page ink, not an accent.

Two sibling pages should therefore **adopt the same four variables with the same meanings** rather than pick a single accent each. If one needs a distinguishing signal, use the eyebrow line and the `.fact` chip set, not a recoloured palette. Note the two adjacent published pages do *not* share this palette — `tac-payment-reminder-walkthrough.html` uses a seven-colour per-system palette (`--twilio:#EF223A`, `--llm:#5B4BD1`, `--know:#1F9E7A`, `--sms:#E8703A`, `--browser:#2E6FA3`, `--backend:#4D5777`, `--conv:#17838C`, `--ok:#2E7D5B`, `--no:#C05A5A`) on the same light `#ECF1F3`/`#14283A` base, and `Agent-Connect-Implementation-Guide.html` is dark (`--plane:#0e0e13`, `--accent:#f22f46`). So "consistent" here means consistent with `agent-scaffold-architecture`, not with the whole `pages` service.

## Citations

- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L9-L279
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L316-L438
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L560-L841
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L951-L1121
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L1123-L1256
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L1437-L1443
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/agent-scaffold-architecture.html#L1445-L1512
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/03-style.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/04-masthead-topology.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/05-ladder.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/09-limits.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/10-close.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/pages/.build/favicon.frag
- file:///Users/dtolbert/code/tac-langfuse/docs/scaffold-next-steps.html#L299-L340
- file:///Users/dtolbert/code/tac-langfuse/docs/.twilio-pages.json
- file:///Users/dtolbert/code/pages/convo-vs-livekit.html#L273-L300
- file:///Users/dtolbert/code/pages/convo-vs-livekit.html#L502-L607
- file:///Users/dtolbert/code/pages/convo-vs-livekit.html#L680-L760
- file:///Users/dtolbert/code/pages/tac-payment-reminder-walkthrough.html#L361-L395
- file:///Users/dtolbert/code/pages/tac-payment-reminder-walkthrough.html#L1023-L1190
- file:///Users/dtolbert/code/pages/tac-payment-reminder-walkthrough.html#L1240-L1300
- file:///Users/dtolbert/code/pages/Agent-Connect-Implementation-Guide.html#L187-L470
- file:///Users/dtolbert/code/pages/.twilio-pages.json
- https://pages-4296.twil.io/agent-scaffold-architecture
- https://pages-4296.twil.io/scaffold-next-steps

## Unverified

- Whether `/agent-scaffold-architecture` is intended to be tracked in `docs/.twilio-pages.json` — the file lists only `scaffold-next-steps`, yet the URL serves the exact 101 425 bytes of the local file. I did not inspect the `pages` CLI to learn whether it writes the manifest on every publish, so this may be a deliberate omission rather than drift.
- Whether the 20 KB favicon data URI is byte-identical across the three published pages. All three contain a `rel="icon"` data URI; I compared only presence, not content.
- Whether `docs/pages/.build/*.frag` concatenate to exactly the emitted HTML. Fragment sizes and boundaries are consistent with it (and `favicon.frag` is clearly a placeholder the build substitutes), but I did not run the concatenation and diff it.
- The `.build` assembly script itself — I did not locate or read it, so the exact ordering/substitution contract is inferred from filenames and fragment contents.
- Every LiveKit-side number quoted from `/convo-vs-livekit` (the ~$0.014 of ~$0.23 minute, the $500/mo HIPAA tier, the $1B valuation, ~25% of US 911 dispatch). That page's own footer states 25 claims including every price are sourced but unverified, researched July 2026. I did not independently check any of them.
- Whether the tac-langfuse scaffold's TAC findings (v2.2.0) contradict `/agent-connect-implementation-guide`'s claims in a way a reader would notice — the guide does not state an SDK version, so the two may simply describe different releases.
- Whether `/tac-payment-reminder-walkthrough`'s JS is byte-identical to `agent-scaffold-architecture`'s. Both use the same `panelFor` / `toggleStep` / `data-node` idiom and the walkthrough's script opens with the same `panelFor` body, but I did not diff the two scripts.
