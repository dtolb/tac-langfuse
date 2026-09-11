# T14 implementation plan — Conversation Memory + built-in tool adapters

Implements `docs/superpowers/specs/2026-09-11-t14-memory-and-builtin-tools-design.md` (committed
`638ff5c`). Base: `03107cb`, typecheck 0, 239 tests / 14 files.

**This plan describes data flow and code flow only. It contains no source code by design** — the
implementing agents write that. Where a shape matters, it is named in prose and its fields listed; where
an ordering matters, it is stated as a constraint with the reason it exists.

Read the spec first for *why*. This is *what, in what order, and what proves it*.

---

## Part 1 — The four flows

Everything in Part 2 is in service of these. An implementing agent that gets a flow wrong will still pass
typecheck and most tests, which is why they are written out before the tasks.

### Flow A — memory reaching the system prompt

```
inbound: SMS webhook envelope          |  voice `prompt` WebSocket frame
    │                                  |
    ├── TAC, before our callback ──────┴─────────────────────────────────────────┐
    │     memoryMode gate decides whether to Recall at all:                      │
    │       'always' → once per message, caller's utterance sent as the query     │
    │       'once'   → once per conversation, NO query, cached on the session     │
    │     Recall → TACMemoryResponse { observations, summaries, communications,   │
    │                                  meta }                                    │
    │     spread onto the callback payload — voice as `userMemory`, SMS as        │
    │     `memory`. A Recall failure is caught inside TAC and yields `undefined`. │
    │                                                                            │
    ├── our channel handler ────────────────────────────────────────────────────┘
    │     TurnInput.memory    ← that payload, VERBATIM and opaque
    │     TurnInput.profileId ← session.profileId          ← NEW on voice (Task 5)
    │
    └── runTurn
          ├─ CONCURRENT (existing `Promise.all`, run-turn.ts:204) ──────────┐
          │    prompts.getActive()                                          │
          │    memory.recall span → composeMemory.compose({ memory,         │
          │                            conversationId, channel })           │
          │      │                                                          │
          │      │  createTacMemoryPort(tac) — server/twilio/, closes over tac
          │      ├─ memory is null/undefined → return null immediately       │
          │      ├─ ZERO OUT communications        ← the guard, see Flow A′  │
          │      ├─ optional: fetchProfile(profileId) → traits → context     │
          │      ├─ hand response + context to TAC's own section renderers   │
          │      └─ return the string, or null. Never '', never throws.      │
          │                                                                 │
          └─ prompt.compose ←───────────────────────────────────────────────┘
               composeTurn() fills slots, collects system parts, and APPENDS the
               memory string as one more system part (run-turn.ts:110).
               reports: systemChars, historyMessages, + memoryChars   ← NEW (Task 6)
```

**Memory is not a slot.** `SLOT_NAMES` is `persona`, `company_name`, `channel`, `current_date` and memory
is none of them. It arrives as an appended system part, so **`slots.ts` and the compiled prompt text in
`defaults.ts` need no change whatsoever.** Do not add a `{{memory}}` placeholder; an unknown slot renders
as a visible `[[UNKNOWN SLOT: memory]]` marker and would ship that into a live prompt.

### Flow A′ — why communications are zeroed rather than limited

```
happy path:  Recall succeeds → response.communications is [] because
             communicationsLimit is already 0 (process-wide default)
                    │
error path:  Recall THROWS → TAC catches it and falls back to
             conversationClient.listCommunications(session.conversationId)
                    │        ← signature takes NO limit parameter
                    ▼
             a TACMemoryResponse whose communications are THIS conversation's
             messages, which the renderer turns into `## Recent Message History`
             of `User:` / `Assistant:` lines
                    │
                    ▼
             the model now sees this conversation twice — once as real
             history messages, once as prose in the system prompt
```

The config value protects the happy path and nothing else. **Zeroing `communications` inside our port
covers both paths**, which is the whole reason the guard lives in our code. Its test feeds the port a
response that *does* carry communications and asserts the rendered string contains neither the heading nor
any `User:` line.

### Flow B — a built-in tool being called

```
prompt config `.tools` — NAMES ONLY, from Langfuse or the compiled default
    │
    └─ deps.tools(names, { conversationId, channel })     ← resolve, bound to the AUGMENTED catalog
         ├─ not in catalog                       → unknown[]     → one warn, turn proceeds
         ├─ in catalog, `requires` unsatisfied   → unavailable[] → one debug, turn proceeds
         └─ otherwise                            → resolved[]
              │
              └─ model.stream({ tools: resolved, toolCtx })
                   toolCtx = { conversationId, logger, profileId }      ← profileId NEW (Task 5)
                   │
                   └─ each ToolDef → ai `tool()` with its ZOD schema as inputSchema
                        │
                        └─ model emits a call → Zod validates the args → execute(args, ctx)
                             │
                             └─ builtin-tools.ts adapter body:
                                  ├─ construct the TAC tool NOW, not at boot
                                  │    (the adapter's closure already holds `tac`)
                                  │    construction throws → catch → return a STRUCTURED MISS
                                  │    addressed to the model, plus one warn. Never rethrow.
                                  └─ invoke the TAC tool's implementation with the validated
                                     args → return its result to the model
```

Two properties to preserve, both already conventions in this repo: a tool failure is **a structured
result the model can talk about**, never a throw (a throw mid-turn is dead air on a live call); and the
**vendor object never crosses the seam** — `tac` is captured in the adapter's closure inside
`server/twilio/`, so nothing in `server/agent/` names anything from TAC and `architecture.test.ts` needs no
new rule.

### Flow C — extraction, which happens entirely outside our process

```
a conversation reaches INACTIVE or CLOSED
    │
    └─ Conversation Orchestrator, server-side, ASYNCHRONOUS, no participation from us
         └─ if memoryExtractionEnabled: derive observations + summaries from the
            conversation's communications
              └─ write them into the memory store
                   └─ visible to the NEXT conversation's Recall
```

**No code we write appears in this flow.** That is precisely why the only honest instrument is reading the
store directly (Task 1), and why the only honest proof needs a second conversation (Task 7). There is no
mid-conversation extraction: nothing our process does during a call can make memory richer for that call.

### Flow D — how the augmented dependencies are built at boot

```
index.ts
  config = loadConfig()                      the ONE env read
  caps   = capabilities(config)
  base   = createTurnDeps(...)               passthroughMemory + the shipped 3-tool catalog
    │
    ├─ bench route  ← base, unchanged        ← T11's TAC-free property, preserved by construction
    │
    └─ caps.sms || caps.voice → DYNAMIC import of ./twilio/tac.ts
         bootTac({ app, config, caps, turn: base })
           tacTools = adaptBuiltInTools(tac)                    closure captures tac
           catalog  = createToolCatalog([...SHIPPED_TOOLS, ...tacTools])
           memory   = createTacMemoryPort(tac)
           augmented = { ...base, tools: <resolve bound to catalog>, composeMemory: memory }
             │
             └─ BOTH channel handlers close over `augmented`
```

**Correction to the spec, found while planning: one augmented dependency object, not one per channel.**
The spec argued per-channel deps were forced because voice must plumb `profileId`. That was wrong —
`profileId` rides on `TurnInput`, which is per-turn, not on `TurnDeps`, which is per-process. And
`composeMemory` already receives `channel` in its argument, so any channel-specific behaviour lives inside
the port. Build one, share it. If a genuine per-channel difference appears later, the spread makes adding a
second trivial.

Rejected alternative, for the record: a settable holder in `server/agent/` that `bootTac` fills in. It
makes `composeMemory` time-dependent — a turn racing boot silently gets the passthrough — and puts a
mutable global on the seam whose entire purpose is injection.

---

## Part 2 — Tasks

Dependency graph. Wave 1 is four independent tasks and can be dispatched in parallel.

```
  Wave 1          Wave 2      Wave 3     Wave 4        Wave 5
  ─────────────────────────────────────────────────────────────
  1 account+verify ──────────────────────┐
  2 knowledge base ──────────────────────┤
  5 profileId ──────► 4 adapters ──┐     │
  3 compose port ──────────────────┴─► 6 wiring ─► 7 live proof ─► 8 docs
```

Task 1 goes first regardless of parallelism: its feedback loop is measured in **minutes of waiting**, and
the answer to its open hypothesis gates how Task 7 is interpreted.

### Task 1 — the account flip, and the instrument that reads it

**Goal.** Turn extraction on, and build the diagnostic that says whether it actually did anything.

**Flow.** `scripts/verify-memory.ts` joins the five existing `verify-*` diagnostics and answers three
questions in order: what does the CO configuration say (`memoryExtractionEnabled`, `memoryStoreId`); does
that store exist; and does the demo profile hold any observations or summaries today. It reads
configuration through the REST API and the store through the Memory API, prints a verdict a human can act
on, and exits non-zero on a surprise so it doubles as a smoke check.

The flip itself is a **full-replace PUT**: GET the entire configuration body first, change one boolean,
send everything back. Every omitted mutable field is deleted.

**Back the configuration up before the PUT, and prove the backup is good before trusting it.** Sequence:

```
GET the full configuration body
   └─ write it VERBATIM to .superpowers/t14/co-config-<id>-<utc-timestamp>.json
        └─ re-read that file and confirm it parses and still contains every
           top-level key the response had          ← do this BEFORE the PUT
             └─ only then send the PUT
```

The re-read is not ceremony. A truncated or half-written backup is *worse* than none, because it reads as
recoverable right up until the moment it is needed. This repo's rule is to prove a guard bites before
trusting it, and the cheap version of that here is confirming the file round-trips.

Recovery is then a single operation: PUT the saved body back, unchanged. It is the exact pre-flip state,
so the undo needs no reconstruction and no judgement.

`.superpowers/` is gitignored, which is the right place: the body carries the account's own configuration
ids, and HANDOFF is explicit that account-specific ids must not be committed — this repo is cloned per
demo, so a committed body hands the next clone another account's values looking authoritative. Do **not**
put the backup in `/tmp`; it needs to outlive a reboot.

**Constraints that will bite.**
- `twil` has no update verb for this endpoint, and `twil … fetch` renders only `id` and `displayName` even
  with `--output json`. GET the full body with `curl`.
- Do **not** touch `channelSettings.VOICE.captureRules` or `statusTimeouts`. Voice capture rules must stay
  empty — adding them double-bills STT under ConversationRelay, and the transcripts already arrive without
  them.
- TAC caches the configuration at boot, so the agent must be restarted before the flip is observable to
  the process.
- The PUT is a live account mutation. It is **authorized for T14** (see Task 7's note on authorization),
  but it is authorized *with* the backup above, not instead of it.

**Done when.** The script reports `memoryExtractionEnabled: true` against a store that exists, and prints
the current observation count as a baseline for Task 7 to compare against.

**Open hypothesis to record either way.** The docs say the boolean plus a store is sufficient. This
account disagrees: the one configuration with real observations also has a populated
`intelligenceConfigurationIds`, and every one of its observations carries an
`intelligence_operatorresult_*` source, while ours has an empty array. If Task 7 finds no observations
after real traffic and a close, attaching an intelligence configuration is the next lever — **not** capture
rules. Write the outcome into HANDOFF in Task 8 whichever way it goes.

### Task 2 — the Knowledge Base and its content

**Goal.** Make `search_knowledge` a real tool rather than a guarded absence.

**Flow.** Provision a knowledge base, author Northwind Traders content, put its id in `.env` as
`TWILIO_KNOWLEDGE_BASE_ID`. Nothing else: `server/config.ts` already reads `knowledgeBaseId` and already
derives `capabilities().knowledge` from it, and `.env.example` already documents the variable as
empty-means-absent. **No config code changes.**

**Content constraint, and it is the substance of this task.** The content must cover what the two demo
tools do **not**, or the model has no reason to prefer it and tool selection becomes ambiguous. In scope:
returns and exchanges, shipping timeframes, warranty terms, damaged-item claims, price matching. Out of
scope: order status (that is `lookup_order`) and store hours (that is `get_store_hours`). Match the
existing fixtures' world — Northwind Traders, the persona Ada, the same product vocabulary as the orders in
`catalog.ts`.

**Constraint.** The CO configuration cannot supply this id. `TAC.create` reads exactly one field off the
fetched configuration — `memoryStoreId` — and never a knowledge base, so attaching a KB there would carry
nothing into the process. It needs its own env var.

**Done when.** A read-only search against the base returns relevant content for a question the demo tools
cannot answer, driven from a script. Knowledge API calls are not billed traffic, so this is free to
exercise repeatedly.

### Task 3 — the memory compose port

**Goal.** `server/twilio/memory-compose.ts`, implementing the existing `MemoryComposePort` unchanged.

**Flow.** As Flow A and A′. The port takes the opaque payload, the conversation id and the channel; it
returns a string of composed context or `null`. Internally: bail early on absent memory; zero
`communications`; optionally enrich with profile traits; hand the result to TAC's own section renderers
rather than building strings by hand; return.

**Use TAC's renderers, not our own.** The response object carries a method that emits its 0–3 available
sections in fixed order and omits any whose data is empty, and the static builder wraps them under a
`# Customer Context` header and can prepend a `## Customer Profile` section from a context object. Working
*with* TAC is the standing convention, and it means a TAC upgrade that improves the phrasing improves ours.

**Profile traits cost a round-trip we have to make ourselves.** Nothing in TAC ever populates the
session's `profile` field, the Recall response carries no traits, and the fetch method is public with no
internal callers. So `## Customer Profile` only appears if we fetch it. Dan approved including it. Give
that fetch **its own timed step** — unlike the recall, it is real measurable I/O, and the repo's rule is
that a step gets a span when it costs something. Note also that the trait-group filter on the fetch and
the trait filter on the render are two independent knobs: keep them in step or set only one.

**Never throws, returns `null` not `''`.** An empty string would become a blank paragraph in the system
prompt, and "no memory" should be indistinguishable from "no memory port". `composeTurn` also guards
`!== ''`, so this is belt-and-braces rather than the only protection — keep both.

**Done when.** Three unit tests pass, and the middle one has been shown to bite by temporarily removing
the guard: a response carrying communications renders neither the `## Recent Message History` heading nor
any `User:` line; a response with observations renders them; a port whose internals throw returns `null`
and the turn proceeds.

### Task 4 — the built-in tool adapters

**Goal.** `server/twilio/builtin-tools.ts`. Two tools adapted, two deliberately not.

**Flow.** As Flow B. A factory takes the live TAC handle and returns `ToolDef`s. Each one carries a
hand-written Zod mirror of the corresponding TAC tool's JSON Schema, sets `requires` to the capability it
needs, and constructs the underlying TAC tool **lazily inside `execute`**.

**Which, and why the two omissions are deliberate.**

| Tool | Adapt | Notes |
|---|---|---|
| `retrieve_profile_memory` | yes, `requires: 'memory'` | 7-field mirror. Needs `ctx.profileId` — without Task 5 it throws on every voice call. |
| `search_knowledge` | yes, `requires: 'knowledge'` | 1-field mirror. **Its name and model-facing description are ours to write**, not TAC's — the factory takes both as required arguments and never uses its own enum value. Write the description as prompt text: it is how the model chooses between this and the two demo tools. |
| `send_message` | **no** | Redundant with streaming; its send path throws *synchronously* on a closed socket; and the literal string is already the unknown-tool fixture in two existing tests. |
| `handoff` | **no — T14b** | Blocked on the Studio flow SID. Its other two construction guards already pass. |

**Zod mirrors, not the raw-schema escape hatch.** The AI SDK does accept a raw JSON Schema, but three
things break if we use it: the projection helper that feeds the T19 console has no Zod object to work
from; the raw path performs **no argument validation at all**; and TAC ships the identical Zod shape
internally, so we would be mirroring a mirror. The mirrors total roughly twenty lines across all four
tools. Use the input projection when generating the comparison schema — it keeps defaulted fields out of
`required`, which is what makes the drift test match TAC's own empty `required`.

**Lazy construction is the point, not an optimisation.** It keeps the knowledge factory's
construction-time network call off the boot path, where one thing that can fail for external reasons
already lives; it means a tool whose capability is absent is never constructed at all; and it turns a
construction failure into a structured miss the model can speak about rather than a boot crash or dead air.

**Done when.** A drift test per adapted tool asserts the projected mirror deep-equals the TAC tool's own
schema, so a TAC upgrade that changes a schema fails CI rather than production. Plus: a tool whose
capability is absent lands in `unavailable` and never constructs; a construction failure returns a
structured miss and logs once.

### Task 5 — `profileId` onto `ToolCtx` and onto the voice turn

**Goal.** Make the profile id reachable by tools and by the compose port on both channels. Small task,
prerequisite for Task 4's runtime behaviour and for voice memory.

**Flow.** `ToolCtx` gains exactly one field, `profileId`, nullable. `run-turn.ts` forwards
`TurnInput.profileId` into the ctx it builds — the value is already on the input and is simply not passed
through. On voice, the handler stops hardcoding `null` and reads the id off the session TAC already puts on
the prompt payload.

**Two comments to correct in the same edit, because both are wrong and both are load-bearing to a reader.**
The voice handler says the session is absent under `memoryMode: 'never'` and that no profile id is on the
payload at all. The actual spread gates `session` on its own existence, not on the memory mode — so the
session has been reachable all along and merely discarded, and its `profileId` with it. Also correct the
pre-authorisation comment on `ToolCtx`, which anticipated widening it with a TAC handle: no handle is
needed, because the adapter closes over `tac`. Only `profileId` crosses the seam.

**Blast radius, which is the intended signal.** Adding a required field to `ToolCtx` is a compile error at
`run-turn.ts` and at every test's ctx helper. That is small, mechanical, and exactly how a new per-turn
value should announce itself.

**Done when.** Typecheck is clean, and a voice turn reports a non-null profile id where it previously
reported `null`.

### Task 6 — wiring, `memoryMode`, and the instrument on `prompt.compose`

**Goal.** Connect Tasks 3 and 4 into the boot path and turn memory on.

**Flow.** As Flow D: build the adapted tools, build an augmented catalog from the shipped tools plus them,
build the TAC memory port, and produce **one** augmented dependency object shared by both channel
handlers. Flip `memoryMode` — voice to `'once'`, SMS to `'always'`. Add `memoryChars` to what
`prompt.compose` reports, beside the existing `systemChars` and `historyMessages`.

**`memoryChars` is the instrument for the whole feature.** Without it, a compose port that silently
returns `null` on every turn is indistinguishable from one that works, because the agent still answers
perfectly well from history and tools. It belongs on `prompt.compose` because that is where
`historyMessages` already lives and the two answer the same operator question from opposite sides.

**Comments that become wrong the moment this lands.** The SMS channel's block explaining `'never'` argues
that `'always'` would make TAC fold history into the prompt. TAC composes no prompt at all — the reasoning
describes a mechanism that does not exist, and the replacement comment should say what is actually true:
memory mode controls only whether Recall happens, and what reaches the model is the compose port's choice.
The voice block's deferral to T14 should be replaced with the measured cost of `'once'` once Task 7 has a
number. The boot log line that reports `memoryMode: 'never'` must stop lying.

**Done when.** Typecheck and the full suite are green with 239 tests as the floor; the bench still runs the
passthrough port and the three shipped tools; and a turn on either channel reports a `memoryChars` value.

### Task 7 — the live proof

**Billed traffic, pre-authorized for T14.** The repo owner has granted standing authorization for the
calls and messages this task needs — no per-step confirmation. That authorization is his to give for *this*
account and is deliberately **not** recorded as a property of the scaffold: this repo is cloned per demo,
and a committed "traffic is free" hands the next clone a permission its owner never granted. HANDOFF's
general convention stays as it is for that reason.

Two things authorization does not remove: run the free checks first (they catch most failures at no cost),
and keep the account mutation in Task 1 behind its backup.

**Goal.** Distinguish memory from history, which no other check in the repo can do.

**Flow.**

```
conversation 1 (SMS)   establish a fact absent from every fixture and every prompt
      │
      ▼                wait for CLOSED — roughly five minutes, measured from
                       CREATION rather than from the last message on the one
                       sample we have
      │
      ▼                verify-memory.ts → observations present in the store?
      │                   no  → the intelligence-configuration hypothesis (Task 1)
      │                   yes → continue
      ▼
conversation 2         NEW conversationId. Ask for that fact.
                       history.ts is EMPTY for this conversation, so a correct
                       answer can only have come from memory.
```

That last line is the entire assertion. It is the structural twin of T12's turn-2 proof, where zero tool
calls was what made the result conclusive — here it is the fresh conversation id doing that work.

Then one voice call, for three things at once: the profile id threads through, `## Customer Profile`
renders, and `'once'` gets a measured cost in front of the first spoken word to compare against T13's
2405 ms first-turn figure.

**Done when.** Conversation 2 answers from memory, and the voice call yields a number for the recall cost.

### Task 8 — the corrections

**Goal.** Leave the docs true, so the next session does not re-derive any of this.

Five corrections from the spec's §1 land in `docs/HANDOFF.md` and, for the tests one, in the plan's footgun
table: TAC ships 31 test files; TAC composes no prompt, which undercuts the recorded reason for
`memoryMode: 'never'` and HANDOFF's correction #9; `communicationsLimit` is already 0 and is not per-channel;
the voice session is present in every memory mode; and the TwiML options docblock misattributes its
defaults. Add the two found while planning: memory is an appended system part rather than a slot, and one
augmented dependency object suffices rather than one per channel.

Then the new material: what `'once'` actually cost, whether the extraction flip alone was sufficient, and
the two-conversation proof written out as the repeatable procedure it now is.

---

## Part 3 — Standing constraints for every task

- **Boot never hard-fails on configuration; it does fail loud on a code error.** A missing knowledge base
  id disables a tool with one debug line. A duplicate tool name in the augmented catalog throws at
  construction, and should.
- **Only `server/twilio/` imports TAC.** Both new files live there. The architecture test needs no new
  rule, and if an implementation finds itself wanting one, the design has drifted.
- **No mocking library, no snapshots.** Injection is the only seam. If a test wants to mock, the seam is
  wrong.
- **Prove a guard bites before trusting it.** Specifically the communications exclusion in Task 3 — remove
  it, watch the test fail, put it back.
- **Verify at the layer where the failure can live.** The communications guard is a unit test; the recall
  cost needs a real call; extraction needs the store read directly. None substitutes for another.
- **Comments explain why and cite what was measured.** Several existing comments are being replaced
  precisely because they explained a mechanism nobody had checked.
- **Billed traffic is authorized for T14** (Task 7). Still run the free checks first — a failure caught by
  the compose-port unit test costs nothing, and the same failure caught by an SMS round-trip costs a
  five-minute close wait before it even becomes visible.
- **Back up before any account mutation, and verify the backup round-trips before relying on it** (Task 1).
  Authorization to change something is not the same as being able to change it back.
- **One review pass at the end**, over the whole change, rather than per task.
