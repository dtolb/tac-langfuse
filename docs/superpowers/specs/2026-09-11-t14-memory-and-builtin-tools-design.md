# T14 — Conversation Memory + built-in tool adapters

Design, 2026-09-11. Approved by Dan before writing. Successor to T13 (`03107cb`).

**In scope:** Conversation Memory turned on for both channels; TAC's built-in tools adapted into the
code-owned catalog; a real Knowledge Base with Northwind Traders content so `search_knowledge` works.

**Out of scope, moved to its own spec (T14b):** Studio handoff and the browser softphone. The cut is at
the `web/` boundary — T14 is server-only and needs no new Twilio resource beyond one CO field and one
Knowledge Base.

Everything below was verified by reading the installed 2.2.0 bundle, the v2.2.0 source checkout, or the
live account. Where something is a hypothesis rather than a finding, it says so.

---

## 1. Corrections this design makes to existing docs

Five. All were stated confidently in `docs/HANDOFF.md`, in the plan, or in code comments, and all are
wrong. Fix each **in the same commit** as the code that depends on it, or the next session re-derives it.

### 1.1 TAC does publish tests — 31 of them

`docs/HANDOFF.md` ("TAC ships no tests") and the plan's footgun #35 ("TAC publishes no tests, so any
citation of `tests/*.test.ts` is source-only and not test-backed") are both false. The v2.2.0 source
checkout at `/Users/dtolbert/code/demo-building-tools/twilio-agent-connect-typescript` ships **31 test
files**. Four cover the built-in tools (`tests/handoff.test.ts`, `tests/tools.test.ts`, and two memory
suites). This design cites them as evidence, which the old claim forbade.

Only `node_modules/twilio-agent-connect` is test-free — it is dist-only. That is what the original
observation was actually about.

### 1.2 TAC never composes a system prompt — so `memoryMode` cannot duplicate history

`server/twilio/tac.ts:191-200` says: *"With `'always'`, TAC calls Recall scoped to the CURRENT
conversation and folds the result into a `## Recent Message History` block."* **TAC folds nothing.**
`MemoryPromptBuilder` has zero callers anywhere inside TAC — grep `MemoryPromptBuilder` and `.compose(`
across `packages/` and the only hits are its own definition.

`memoryMode` decides exactly one thing: whether, and how often, Recall is called. The `TACMemoryResponse`
is handed to our callback (`packages/core/src/channels/messaging.ts:400-412`; voice
`packages/core/src/channels/voice.ts:729`) and **what reaches the model is entirely our compose port's
decision.**

So the recorded reason for choosing `memoryMode: 'never'` at T12 — and HANDOFF's correction #9, which
repeats it — describes a mechanism that does not exist. The decision was still defensible (a passthrough
port made Recall pointless), but not for the stated reason.

### 1.3 `communicationsLimit` is already 0, and is not a channel option

`TwilioMemoryConfigSchema.communicationsLimit` is `z.number().int().min(0).max(100).default(0)`
(`packages/core/src/types/config.ts:19`), asserted at `tests/config.test.ts:485`. `server/twilio/tac.ts`
omits `memoryConfig` entirely, and `memoryConfig` is `.prefault({})` — so **the running app already has
`communicationsLimit: 0`.** Setting it changes nothing.

It is also **not** settable per channel: `BaseChannelOptions` has exactly two members, `memoryMode` and
`dedupCapacity` (`packages/core/src/channels/base.ts:30-45`). It lives only on process-wide
`TACConfig.memoryConfig`.

⚠ TAC's own JSDoc at `packages/core/src/types/memory.ts:169-170` claims the default is 10. It is stale.
Cite the schema, not the comment.

### 1.4 `session` IS on the voice prompt payload, in every memory mode

`server/twilio/voice.ts:81` says `session` is conditionally spread and therefore absent under
`memoryMode: 'never'`. The actual spread (`packages/core/src/channels/voice.ts:726-742`, dist
`index.js:5167-5176`) is:

```js
...userMemory !== void 0 && { userMemory },
...session    !== void 0 && { session }
```

Only `userMemory` is memory-mode gated. `session` is gated on its own existence, and a session always
exists by the time `handlePromptMessage` runs. So **the session is reachable today and merely
discarded**, and `voice.ts:221`'s *"Not on the voice prompt payload at all"* is wrong about `profileId`
too — it is `session.profileId`.

Consequence: the memory change and the handoff change are **not coupled** and can land in either order.

### 1.5 `VOICE_TWIML_OPTIONS`'s docblock misattributes its defaults

It credits TAC with ElevenLabs TTS, Deepgram `nova-3-general` and `interruptible: 'any'`. TAC sets
**none** of them — every field on `TwiMLOptionsSchema` is `.optional()` with no `.default()`
(`packages/core/src/types/crelay.ts:273-400`), and `buildTwimlOptions` seeds only `welcomeGreeting` and
`conversationConfiguration`. Those are *Twilio platform* defaults for unset attributes. The conclusion
(don't pin them) stands; the attribution does not.

---

## 2. The product fact that shapes everything: extraction is post-conversation only

*"There is no mid-conversation extraction."* Extraction fires on `INACTIVE`/`CLOSED` lifecycle
transitions. **Recall works on every turn regardless of the extraction flag** — but there is nothing to
recall until a *prior* conversation has closed and been processed.

Three consequences, all of which must be said out loud rather than discovered on stage:

- **Conversation Memory makes the NEXT conversation smart, not the current one.** "The agent remembered
  what I said a minute ago" is `server/agent/history.ts`. Memory is "the agent remembered me from last
  week."
- **Any honest test needs two conversations with a close between them.** See §7.
- **`history.ts` and memory are not redundant** and neither replaces the other. History is within-
  conversation and process-local; memory is cross-conversation and durable.

## 3. Ingestion: no voice capture rules, and the current design is the documented one

Voice memory does **not** need `channelSettings.VOICE.captureRules`. Capture rules are the *passive*
ingestion mode; naming the configuration on the `<ConversationRelay>` noun is **Active TwiML**
ingestion, and that is the documented mechanism.

Proven on this account, not inferred: `scaffold-demo`
(`conv_configuration_01m28k6yq0e769bzby8fayh41p`) is version 1, never updated, `VOICE.captureRules: []`
from birth — and already holds **two CLOSED voice conversations from 2026-09-11** (17:32 and 18:13) with
a resolved `profileId` and 11 and 13 `TRANSCRIPTION` communications carrying both sides' full text.
Transcripts are already arriving in Conversation Orchestrator with no capture rules at all.

HANDOFF's existing rule ("voice `captureRules` must stay EMPTY") is therefore right, and now has a
citation rather than only a billing worry:

> **Warning.** If your configuration has voice capture rules and you pass the
> `conversationConfiguration` parameter to a `<ConversationRelay>` element for the same call, you pay for
> STT twice. Remove voice capture rules from your configuration when using active TwiML with
> Conversation Relay.

**Do not add voice capture rules.** The only account change T14 makes is §6.

---

## 4. Architecture — how TAC-flavoured dependencies reach `runTurn`

The seam already exists and needs no new indirection: `bootTac` receives the whole `TurnDeps`
(`server/twilio/tac.ts:105`), and `resolve()` accepts an injectable `catalog`
(`server/agent/tools/resolve.ts:44`).

```
server/index.ts
  createTurnDeps(…)  →  base TurnDeps: passthroughMemory + SHIPPED_TOOLS      ← the bench keeps this
      │
      └─ bootTac({ turn: base, … })                       [server/twilio/, the only dir importing TAC]
             tacTools      = adaptBuiltInTools(tac)
             catalog       = createToolCatalog([...SHIPPED_TOOLS, ...tacTools])
             composeMemory = createTacMemoryPort(tac)
             per-channel   = { ...base, tools: resolveWith(catalog), composeMemory }
```

Four properties this buys, each of which an alternative loses:

1. **No TAC import escapes `server/twilio/`.** `tests/architecture.test.ts` needs no amendment. A
   registration function that mutated the module-level `toolCatalog` from outside would have needed one.
2. **No mutation of `toolCatalog`.** It stays exactly what tests and the bench see today, and
   `createToolCatalog`'s duplicate-name throw keeps its meaning — a second catalog is built, the first is
   untouched.
3. **The bench keeps `passthroughMemory` and the three shipped tools BY CONSTRUCTION.** T11's TAC-free
   property is preserved with no special-casing and no `if (channel === 'bench')` anywhere.
4. **Per-channel deps are required, not stylistic.** Voice must plumb `profileId` before
   `retrieve_profile_memory` works there (§5.4), so SMS and voice genuinely differ.

Rejected: a late-bound mutable holder in `server/agent/` that `bootTac` fills in. It works, but it makes
`composeMemory` time-dependent — a turn racing boot would silently get the passthrough — and it puts a
mutable global on the seam whose whole purpose is injection.

---

## 5. Components

### 5.1 `server/twilio/memory-compose.ts` — `createTacMemoryPort(tac): MemoryComposePort`

Implements the existing port (`server/agent/types.ts:163-169`) unchanged. Three non-negotiable
properties:

**Excludes communications by construction.** Not via `communicationsLimit`. That value is already 0, is
not per-channel, and — decisively — **the Recall-failure fallback ignores it entirely.** On any thrown
error from the memory path, `packages/core/src/lib/tac.ts:597-605` calls
`conversationClient.listCommunications(session.conversationId)`, whose signature takes **no limit**
(`packages/core/src/clients/conversation.ts:75`), and the resulting response renders
`## Recent Message History` from the **current** conversation. That is the exact double-visible-history
failure, on a path no config value protects. Zeroing `communications` before rendering is immune to it.

**Never throws.** `try`/`catch` → log → `return null`. Memory is an enhancement; it must not be able to
fail a turn. This mirrors `prompt/langfuse.ts`'s never-rejects contract.

**Returns `null`, never `''`.** The existing contract, and its reason, are in `server/agent/memory.ts:9-10`:
an empty string becomes a blank paragraph in the system prompt, and "no memory" should be
indistinguishable from "no memory port".

Rendering uses TAC's own section builders rather than hand-rolled string work — `buildMemoryPrompts()`
on `TACMemoryResponse` (`packages/core/src/lib/tac-memory-response.ts:117`), which emits 0–3 sections in
fixed order (Key Observations, Past Conversation Summaries, Recent Message History) and omits any section
whose data is empty (`tac-memory-response.ts:172-177` returns `null` on an empty array). Working *with*
TAC, per the standing convention.

The complete heading set that can appear, verbatim and exhaustive:

| Heading | Source |
|---|---|
| `# Customer Context` | `packages/core/src/adapters/prompt-builder.ts:156` — wrapper, whenever ≥1 section exists |
| `## Customer Profile` | `packages/core/src/lib/conversation-session-helpers.ts:72` — needs §5.2 |
| `## Key Observations` | `tac-memory-response.ts:144` |
| `## Past Conversation Summaries` | `tac-memory-response.ts:161` |
| `## Recent Message History` | `tac-memory-response.ts:177` — **the one we suppress** |

`MemoryPromptBuilder` is an **all-static class with no constructor**
(`packages/core/src/adapters/prompt-builder.ts:30`); `build(memoryResponse?, context?, options?)` returns
a single `string` (`''` when there is no data).

### 5.2 `## Customer Profile` costs a round-trip we have to make ourselves

`ConversationSession.profile` is `z.custom<Profile>().optional()`
(`packages/core/src/types/conversation.ts:236`) and **nothing in TAC ever assigns it** — zero assignments
across `packages/`. `tac.fetchProfile(profileId)` (`packages/core/src/lib/tac.ts:619-638`) is public with
**no internal callers**, and the Recall response carries no traits
(`MemoryRetrievalResponseSchema` is `{observations, summaries, communications, meta}` only,
`packages/core/src/types/memory.ts:190-199`).

So profile traits — the part that makes memory feel personal rather than transcript-shaped — are opt-in
work. Dan approved including them. Two constraints:

- The fetch happens inside the compose port, which `run-turn.ts` already runs **concurrently with the
  prompt fetch** (confirmed in HANDOFF's verified waterfall: `memory.recall` is a sibling of
  `prompt.fetch`), so its cost is partly hidden. Partly, not wholly — measure it, don't assume.
- `TWILIO_MEMORY_PROFILE_TRAIT_GROUPS` filters the *fetch* and `AdapterOptions.profileTraits` filters the
  *render*. Two independent filters. If they disagree you fetch traits you then discard; keep them in
  step or set only one.

### 5.3 `server/twilio/builtin-tools.ts` — Zod mirrors, constructed lazily

**Decision: hand-written Zod mirrors, with a drift test. Not `jsonSchema()`.** `jsonSchema()` *is*
exported from `ai@7.0.93` (re-exported at `node_modules/ai/dist/index.d.ts:7`) and *is* accepted as
`inputSchema` (`FlexibleSchema` union, `:841`). It still loses:

1. **`toJsonSchema()` breaks.** `server/agent/tools/registry.ts:118` does
   `z.toJSONSchema(d.input, {io:'input'})`. A `jsonSchema()`-wrapped tool has no Zod object to project, so
   that function — and the T19 console inspector that consumes it — gets nothing.
2. **No validation.** `Schema.validate` is optional and `jsonSchema()` without an explicit `validate`
   does none. The Zod path validates model output before `execute`; the raw path silently does not.
3. **It would be mirroring a mirror.** TAC ships the identical Zod shape internally — dist
   `index.js:633-636` carries `observationsLimit: z.number().int().min(0).max(100).default(20)` verbatim.

Cost is small and measured, not asserted: 7 fields for `retrieve_profile_memory`, 1 each for
`search_knowledge` and `handoff`, 2 for `send_message` — ~20 lines total. `io: 'input'` keeps the
`.default()` fields out of `required`, matching TAC's own `required: []`. A test asserts
`z.toJSONSchema(mirror, {io:'input'})` matches `tacTool.parameters` per tool, so a TAC upgrade that
changes a schema fails CI rather than production.

**The underlying TAC tool is constructed lazily inside `execute`, not at boot.** This is the design
choice most worth preserving:

- capability absent → `resolve()` puts the name in `unavailable`, one debug line, correct diagnostic, and
  the TAC tool is **never constructed**
- capability present but construction throws → caught inside `execute`, returns a structured miss
  *addressed to the model* (the `lookup_order` not-found convention, `catalog.ts`), plus one `warn`
- and it keeps `createKnowledgeSearchToolAsync`'s **network call at construction**
  (`packages/core/src/clients/knowledge.ts:30-40`, rethrows `Failed to get knowledge base: …`) off the
  boot path, where `TAC.create()` has already put one thing that can fail for reasons outside the process

Boot still gets a loud signal: `preflightDefaultPromptTools()`
(`server/agent/tools/resolve.ts`) already errors per compiled-prompt name that nothing answers to, and
that now runs against the augmented catalog.

**`ToolCtx` must gain `profileId: string | null`, and only that.** `ToolCtx` is
`{conversationId, logger}` today (`server/agent/tools/registry.ts:50-53`), built at
`server/agent/run-turn.ts:306`. `createMemoryRetrievalTool(memoryClient, profileId?, conversationId?, …)`
takes `profileId` as a constructor argument, and under lazy construction that construction happens at call
time — so the value has to arrive on the ctx. It is already on `TurnInput.profileId`; `run-turn.ts:306`
simply does not forward it.

Note this **sharpens** the pre-authorisation at `registry.ts:42-49`, which anticipated widening `ToolCtx`
with *"a TAC handle"*. No TAC handle is needed: `adaptBuiltInTools(tac)` closes over `tac`, so the vendor
object never reaches the seam and `server/agent/` still names nothing from TAC. Only `profileId` crosses.
Update that comment to say so, or the next reader widens further than necessary.

### 5.4 Which tools, and which are deliberately skipped

| Tool | Adapt? | Why |
|---|---|---|
| `retrieve_profile_memory` | **Yes**, `requires: 'memory'` | 7-field schema. Works on SMS today. On voice it throws `No profile ID available for memory retrieval` (`packages/tools/src/built-in/memory.ts:93`) on **every** call until §5.5 lands. |
| `search_knowledge` | **Yes**, `requires: 'knowledge'` | Needs §5.6. `BuiltInTools.SEARCH_KNOWLEDGE` is never used by the factory — `name` and `description` are required constructor args (`packages/tools/src/built-in/knowledge.ts:28-53`), so the tool's name and its model-facing description are **ours to write**. Write them per `registry.ts:58-61` (prompt text, not a code comment). |
| `send_message` | **No** | Redundant — the model already speaks/sends its answer. `sendResponse` is not `async` in the bundle, so its closed-socket guard throws **synchronously** (already documented at `server/twilio/voice.ts:100-104`). And `tests/tools.test.ts:139,155` uses the literal string `'send_message'` as its **unknown-tool fixture**, so adding it for real breaks two existing tests. |
| `handoff` | **No — T14b** | Blocked on guard 1 of 3, `TWILIO_STUDIO_HANDOFF_FLOW_SID` (`packages/tools/src/built-in/handoff.ts:132-135`). Guards 2 and 3 already pass on this account. |

### 5.5 Voice `profileId` plumbing

`server/twilio/voice.ts:221` hardcodes `profileId: null` with the comment *"Not on the voice prompt
payload at all"*. Per §1.4 that is wrong: `session` is on the payload in every memory mode and carries
`profileId`. Thread `session.profileId` through `VoicePrompt` into `TurnInput.profileId`.

Required by both `retrieve_profile_memory` on voice and `## Customer Profile`. Fix the comment in the
same edit.

A second, independent route exists if ever needed: `getConversationSession(conversationId)` is public on
`BaseChannel` (`packages/core/src/channels/base.ts:226`) and returns the **live object by reference**, and
the scaffold already holds the channel instance and passes it as `sender` (`server/twilio/tac.ts:278`).

### 5.6 The Knowledge Base

`server/config.ts` already carries `knowledgeBaseId` and `capabilities().knowledge`
(`orchestrated && c.knowledgeBaseId !== null`), and `.env.example:116-118` already documents
`TWILIO_KNOWLEDGE_BASE_ID` as empty-means-absent. **No config work is needed** — only the resource and
the value.

Provision a Knowledge Base and author Northwind Traders content. **Content must cover what the two demo
tools do not**, or the model has no reason to choose it: returns and exchanges, shipping timeframes,
warranty terms, damaged-item claims, price matching. **Not** order status (`lookup_order`) and **not**
store hours (`get_store_hours`). Overlapping content makes tool selection ambiguous and the demo worse.

⚠ The CO configuration **cannot** supply the id. `TAC.create` reads exactly one field off the fetched
configuration — `conversationConfig.memoryStoreId` (`packages/core/src/lib/tac.ts:115`) — and never a
knowledge base. `KnowledgeClient` itself is created unconditionally in orchestrated mode (`tac.ts:122`),
so only the id is missing.

### 5.7 `caps.memory` stays as it is; the gap is an instrument, not a flag

`capabilities().memory` is `orchestrated` (`server/config.ts:243`), so it is **already `true` on HEAD**
while `memoryExtractionEnabled` is `false`. A tool gated on it resolves and then returns nothing.

That is not dishonest, and splitting the flag would make it so. `caps.memory` means *"Recall is
available"*, which is true — observations can be written directly by API and recalled immediately. What is
missing is not a narrower flag but an **instrument**.

**`scripts/verify-memory.ts`**, matching the five existing `verify-*` diagnostics: read the CO
configuration and report `memoryExtractionEnabled` and `memoryStoreId`; read the store's observations for
the demo profile; and state plainly whether extraction has ever produced anything. Exits non-zero on a
surprise, so it doubles as a smoke check. This is the answer to *"is memory actually on?"*, which no
`/health` field can honestly give.

---

## 6. The one account change

`memoryExtractionEnabled: true` on `conv_configuration_01m28k6yq0e769bzby8fayh41p`.

- **Full-replace PUT.** Every omitted mutable field is deleted. GET the whole body with `curl` first —
  `twil api conversations configurations fetch` renders only `id` and `displayName` even with
  `--output json`. There is no update verb in `twil`'s surface for this endpoint.
- Base URL is not guessable; `--log-level debug` prints it:
  `https://conversations.twilio.com/v2/ControlPlane/Configurations/{id}`.
- **Do not touch `channelSettings.VOICE.captureRules`** (§3) or `statusTimeouts`.
- **TAC caches the configuration at boot** (`TAC.create` GETs it), so the agent must be restarted before
  the flip is observable to the process.

**Open hypothesis, and the single biggest risk to the happy path.** The docs' truth table names only
`memoryExtractionEnabled` + `memoryStoreId`. But the one configuration on this account with real
observations — `Flight-sandbox-conversations` — has extraction `true` **and** a populated
`intelligenceConfigurationIds`, while `scaffold-demo` has `[]`; and **every** one of that profile's 50
observations has `source: intelligence_operatorresult_*`. If the flag alone yields no observations after
real traffic and a close, attaching an intelligence configuration is the next lever — **not** capture
rules. Record the outcome either way; this is exactly the kind of thing the next session should not have
to rediscover.

---

## 7. Verification

### Free — no billed traffic

| Check | Proves |
|---|---|
| `scripts/verify-memory.ts` | extraction flag state, store contents, and a baseline to compare against |
| `pnpm test` + `pnpm typecheck` | no regression; 239 tests remain the floor |
| Bench turn via `/bench` | still `passthroughMemory` + three shipped tools → **T11's TAC-free property intact** |
| Unit: compose port fed a `TACMemoryResponse` that **does** carry communications | the exclusion **bites**. This is the Recall-failure path (§5.1) and it is the one guard most likely to be silently wrong. Assert the rendered string contains no `## Recent Message History` and no `User:` line. |
| Unit: schema drift, per adapted tool | `z.toJSONSchema(mirror, {io:'input'})` deep-equals `tacTool.parameters` |
| Unit: compose port throwing | returns `null`, turn proceeds |
| `search_knowledge` driven from a script against the real KB | the adapter, the credential and the KB content. Knowledge API calls are not billed traffic. |
| `retrieve_profile_memory` on SMS from a script | the mirror validates, the tool executes, Recall returns |

### Billed — ask first

**The two-conversation proof, which is the only test that can distinguish memory from history:**

1. Conversation 1 (SMS): establish a fact the fixtures do not contain.
2. Let it close. `statusTimeouts.closed: 5` — measured at ~300 s **from creation**, on one sample.
3. `scripts/verify-memory.ts` → observations present in the store.
4. **Conversation 2, with a brand-new `conversationId`**: ask for that fact.

Step 4 is the assertion. A new conversation means `history.ts` is empty, so a correct answer can *only*
have come from memory — the exact structure of T12's turn-2 proof, where `0 tool calls` was what made it
conclusive. **Every other check in this suite passes with memory completely broken.**

Then one voice call: confirm `session.profileId` threads through, `## Customer Profile` renders, and
measure what `'once'` actually costs in front of the first spoken word (`turn.ttft_ms` on turn 1 versus
T13's measured 2405 ms).

### `memoryMode`, as ratified

- **voice `'once'`** — one Recall per conversation, cached on the session, with TAC handling the INACTIVE
  re-fetch. Cost lands on turn 1 only.
- **SMS `'always'`** — a Recall per message. SMS latency is not perceptual, and `'always'` passes the
  caller's utterance as a semantic query, so observations come back ranked by relevance. `'once'` sends
  no query and returns them unranked.
- Safe *because* of §1.2 and §5.1 — our compose port decides what renders — **not** because of
  `communicationsLimit`.

---

## 8. What could silently do nothing

This project's recurring failure mode. Each trap with the specific instrument that catches it.

| Trap | Instrument |
|---|---|
| `memoryExtractionEnabled: false` → nothing ever to recall | `scripts/verify-memory.ts` reading `/Observations` |
| `intelligenceConfigurationIds: []` is a second requirement (§6) | same script, after real traffic **and** a close |
| Compose port returns `null` on every turn | a `memoryChars` attribute on `prompt.compose`, beside the existing `historyMessages` — the number that answers "did it recall?" |
| `## Customer Profile` never renders because `session.profile` is never assigned by TAC (§5.2) | same attribute, plus its own timed step for the `fetchProfile` round-trip |
| Recall-failure fallback re-introduces current-conversation messages (§5.1) | the unit test in §7, which must be shown to bite |
| Voice `retrieve_profile_memory` throws on every call (§5.4) | the voice call in §7; the throw is caught and returns a structured miss, so it is **invisible without the instrument** |
| A prompt version names an adapted tool that did not make it into the catalog | `preflightDefaultPromptTools()` at boot, already built |

`prompt.compose` is the right home for `memoryChars` because that is where `historyMessages` already
lives, and the two answer the same operator question from opposite sides. Per HANDOFF, memory recall
deliberately has **no span of its own** only where it costs nothing measurable — the `fetchProfile` call
does, so it gets one.

---

## 9. Sequencing

1. **The account flip and `verify-memory.ts` first.** Longest feedback loop by far — extraction needs
   real traffic plus a ~5-minute close, and the `intelligenceConfigurationIds` hypothesis can only be
   settled empirically. Start it before writing the port so the answer arrives while other work proceeds.
2. Compose port + the communications-exclusion test. Independent of the flip.
3. Zod mirrors + drift tests + `builtin-tools.ts`. Independent of both.
4. Voice `profileId` plumbing. Prerequisite for voice memory and for the memory tool on voice.
5. Knowledge Base provisioning + content. Independent; can be done in parallel with 2–4.
6. Per-channel deps wiring in `bootTac`, `memoryMode` flip. Depends on 2 and 3.
7. The two-conversation proof, then the voice call. Depends on everything.
8. HANDOFF and plan corrections from §1, plus whatever §6 turned out to be.

## 10. Files

**New:** `server/twilio/memory-compose.ts`, `server/twilio/builtin-tools.ts`,
`scripts/verify-memory.ts`, `tests/memory-compose.test.ts`, `tests/builtin-tools.test.ts`.

**Changed:** `server/twilio/tac.ts` (per-channel deps, `memoryMode`, the wrong comment at 191-200),
`server/twilio/voice.ts` (`profileId`, the wrong comments at 81 and 221, the `VOICE_TWIML_OPTIONS`
docblock), `server/agent/deps.ts` (the T14 note at :57), `server/agent/tools/registry.ts` (the `ToolCtx`
note at :42-49 — resolved by lazy construction, so `ToolCtx` needs **no widening**),
`server/agent/run-turn.ts` (`memoryChars`, and forwarding `profileId` onto `ToolCtx` at :306), `.env`,
`docs/HANDOFF.md`, and the plan's footgun #35.

`server/agent/tools/registry.ts` gains **one field** on `ToolCtx` — `profileId: string | null` (§5.3) —
which is a compile error at every existing `ctx()` test helper and at `run-turn.ts:306`. That is the
intended blast radius and it is small; it is also the honest signal that a new per-turn value now exists.

**Unchanged, deliberately:** `tests/architecture.test.ts` (§4 needs no new rule),
`server/agent/tools/catalog.ts` (`SHIPPED_TOOLS` stays credential-free), `server/agent/memory.ts`
(`passthroughMemory` remains what the bench uses), `server/config.ts` (§5.6, §5.7).
