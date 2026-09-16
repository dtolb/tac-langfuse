# Handoff — demo scaffold

Updated 2026-09-15. Read this first, then `~/.claude/plans/i-want-to-build-reactive-muffin.md`
for the full plan and the footgun list.

**The plan is wrong in twenty-three places now, and so was this file.** Three concern telemetry and
prompt linking (plan footguns #30–#32); nine were found building T12; **eleven more were found building
T14, and two of those correct statements in THIS file** — that TAC ships no tests, and the stated reason
for `memoryMode: 'never'`. Both were specific enough to be believed for two whole tasks.

**T14b then found seven more against its own design and six against THIS FILE**, and the biggest of
the six is the one that reads most authoritatively below (line ~205): the claim that pinning
`actionUrl` lets our callback and Studio "coexist" was true about the precedence and wrong about the
conclusion. Both sets are folded into the T14b section near the end.

Read whichever section matches what you are about to touch. Do not re-derive them; each was verified by
executing it, not by reasoning about it. **Where a claim here and a claim in the design or plan docs
disagree, this file wins** — the T14 spec and plan under `docs/superpowers/` were written before the
work and are wrong in the places their own "corrections" sections now list.

**Account-specific values are deliberately NOT in this file.** SIDs, phone numbers, Conversation
Orchestrator ids and Studio flow SIDs live in `.env` (gitignored) and in this project's session memory
at `~/.claude/projects/-Users-dtolbert-code-tac-langfuse/memory/`. This repo is
*cloned* per demo, so a committed doc carrying one account's ids hands every future clone stale values
that look authoritative. What is here instead is the **method** for discovering them — see
"Twilio credentials" below.

There is a published walkthrough written for a human rather than an agent:
<https://pages-4296.twil.io/scaffold-next-steps> (public, no auth — no credentials on it).
⚠ **It predates T12 and is now stale**: it presents gathering Twilio credentials as the next step and
does not know SMS works. Re-publish it before showing it to anyone, or treat this file as the only
current source.

**Current, and the one to share (published 2026-09-16):**
<https://pages-4296.twil.io/agent-scaffold-architecture> — clickable topology, a 15-hop turn anatomy,
the measured latency table, and the TAC + OpenTelemetry lessons as assumption-against-reality tables.
Source and fragments in `docs/pages/`; rebuild by concatenating `.build/*.frag` in order and re-inlining
the favicon. It is **public with no auth**, so it carries no SIDs, no phone numbers, no hostnames and no
account-specific names. Its content came from THIS file, so this file stays authoritative; when a finding
here changes, the page is stale until re-deployed with `pages deploy --file`.

## What this is

A clonable starting point for customer-facing Twilio demos. Beyond the baseline (UI, agent, backend,
TAC websocket service) it deliberately invests in the three things mature implementations have and
POCs don't:

- **Telemetry** — a per-turn span waterfall with time-to-first-token, so a prompt change that slows
  the LLM is a number rather than a feeling.
- **Prompt management** — versioned, labelled, editable without a redeploy.
- **Tools management** — which tools an agent has, and how they're described, versioned alongside
  the prompt.

All three land in **self-hosted Langfuse**. Its prompt `config` JSON is versioned with the prompt and
is Langfuse's own documented home for `tools`/`tool_choice`/model params.

## Status: T1–T15 done, all four spikes closed — SMS *and* VOICE verified live, WITH MEMORY, A CALLER HANDED TO A HUMAN, AND NOW CONTAINERISED BEHIND TRAEFIK

```
pnpm typecheck   → 0          (TS 7.0.2, node project + web project)
pnpm test        → 327 passed, 19 files
```

**T15 IS DONE: ngrok is retired.** Both processes run as containers behind the Traefik dev box on one
stable public host, split by path — `https://$APP_NAME.twilio.dtolb.com`, `APP_NAME=northwind`. A real
SMS round-tripped through it; routing, TLS, signature validation, the corporate CA at runtime, Langfuse
reachability from inside a container, a 184 s SSE hold and a clean SIGTERM shutdown are all measured.

**Both channels are now proven THROUGH THE CONTAINERS, from an external handset** (2026-09-15 17:56–17:58
UTC, same container process, `restarts=0`). One `conversation.voice` trace held **4 voice turns** and
exercised `lookup_order`, `search_knowledge`, `handoff` and `end_call`; the caller was transferred to
the browser softphone, **a human answered** (`outbound-dial → client:browser_agent`, completed), and the
screen pop was fetched through Traefik. The SMS was **1 inbound → 1 reply**, answered from Conversation
Memory with **0 tool calls**. Telemetry export from inside the container is confirmed in ClickHouse.

⚠ **One thing T15 still has not exercised:** the **45 s TAC shutdown drain**, which needs a SIGTERM
*during* a call. The signal path is proven; the drain is not. See the shutdown bullet in honest limits.

⚠ **TOP OPEN ITEM (2026-09-15): the Conversation Memory block is uncapped and is now 52% of the system
prompt** — 696 chars at T14, **4412 today**. It costs the cold first turn of every conversation (6214 ms
measured) and it is accreting self-contradictory duplicates, so it degrades answers as well as latency.
Nothing is broken; nothing is capped either. See **"Latency, investigated 2026-09-15"**, which carries the
attributed waterfall, the ranked levers, and the two queries for proving a fix. **Do not baseline latency
off the T15 call above — it landed in a 2–5× upstream slow window.**

```
pnpm stack:up     preflight, then docker compose up -d --build   (NOT `pnpm up` — that is `pnpm update`)
pnpm stack:down   docker compose down
pnpm status       host processes, containers, capabilities, and the public URLs
```

**T14 IS DONE AND PROVEN ACROSS TWO CONVERSATIONS.** Conversation Memory is on, TAC's built-in tools
are adapted, and there is a real Knowledge Base with Northwind content. The assertion that matters:

```
conv 1 (SMS)  "always leave my deliveries with the building doorman"     15:58:17Z
              closes 16:03:53Z (5m36s from CREATION, per statusTimeouts.closed: 5)
              observation written 16:03:55Z — extraction latency ~2 SECONDS
conv 2 (SMS)  NEW conversationId  "where should you leave my deliveries?"
              → "I should leave them with the building doorman, not at your door."
              1 step, 0 TOOL CALLS, memory.recall = 1 observation + 1 summary + 1 trait group → 696 chars
```

**A new `conversationId` means `history.ts` was empty, and 0 tool calls means no tool supplied it** —
`retrieve_profile_memory` was offered and not used. So the fact reached the model through Conversation
Memory and nothing else could have carried it. That is strictly stronger than T12's turn-2 proof,
which stayed inside one conversation.

**T12 IS DONE AND PROVEN AGAINST REAL SMS.** Two live turns on `TWILIO_PHONE_NUMBER`, measured:

```
turn 1  "Where is order a4721"                    ttft 1599ms  total 1979ms  2 steps  1 tool (lookup_order)  93 chars
turn 2  "what was the order number I just        ttft 1661ms  total 1766ms  1 step   0 tools                 5 chars
         asked about?"          → "A4721"
both turns: conversationId conv_conversation_01m28kmbk4f7dawyafmmsehn36  (one CO conversation)
```

**Turn 2 is the assertion that matters, and `0 tool calls` is why.** The question contains no order
number, so the answer cannot have come from a tool — it came from `server/agent/history.ts`. An
amnesiac agent passes every other check in this repo.

TTFT on SMS (1599 ms) is consistently *lower* than the bench measured minutes earlier on the same model
and prompt (2189–2624 ms). Unexplained; not chased, per the deferred-latency decision.

**The SMS trace tree is now VERIFIED** (2026-09-11, second live pair of turns — T12's own two turns ran
while Langfuse was down, so those spans were never exported and there was nothing retroactive to look
at). One `conversation.sms` trace, both turns inside it, model calls inside their own turn span:

```
conversation.sms                    5m 00s   $0.001388   is_app_root = true
├─ turn.sms          4.21s   "Where is order A4721?"          2 steps, lookup_order
└─ turn.sms          0.85s   "What was the order number…"     1 step, NO tool node
                             ttft 3720 / 604 ms · 991 / 499 input tokens
```

`closedBecause: "ended"` on the root, so it closed through `tac.onConversationEnded` →
`conversations.end()` — the real path, not the TTL sweep and not shutdown.

| | State |
|---|---|
| S1–S4 spikes | closed |
| T1 foundation | done — root pkg (agent) + `web/` pkg (Next), both tsconfigs |
| T2 architecture test | done — validated by deliberate violation |
| T3 config + logging | done — never throws; PII scrubbing proven through 4 logger views |
| T4 `.env.example` | done — its own test caught a real undocumented variable |
| T5 obs spine | done — bus + SSE hub, 16 frames verified |
| T6 instrumentation | done — real waterfall in Langfuse, 2 turns in 1 trace |
| **T7 prompts** | done — Langfuse by label, compiled-in fallback, `docker pause` proves the 2 s timeout |
| **T8 tools** | done — registry, catalog, three-way resolver, two credential-free demo tools |
| **T9 `runTurn`** | done — the channel-agnostic core, verified against the real model AND in the Langfuse UI |
| **T10 history** | done — bounded two ways, LRU on *use*; a real model repeated an order number from turn 1 and forgot it after `clear()` |
| **T11 bench** | done — `/bench` streams a real turn in a browser with zero Twilio credentials, and the whole thing was re-run with TAC made *unresolvable* |
| **T12 TAC/SMS** | done — a real text to `TWILIO_PHONE_NUMBER` is answered, turn 2 recalled the order number with **0 tool calls**, and the `conversation.sms` trace tree is confirmed in the Langfuse UI |
| **T13 TAC/voice** | **done, proven on two real calls.** One `conversation.voice` trace held all five `turn.voice` spans; turn 2 recalled an order number with **0 tool calls**; barge-in works on real audio; and the agent hangs up by itself via `end_call` |
| **T14 memory + tools** | **done, proven across two conversations.** Extraction on, a real Knowledge Base, `search_knowledge` + `retrieve_profile_memory` adapted with Zod mirrors and drift tests, and conversation 2 recalled a fact from conversation 1 with **0 tool calls on a fresh `conversationId`** |
| **T14b handoff + softphone** | **done, proven on one real call.** The caller asked for a person, the model called `handoff`, the farewell streamed, the real parked frame went out (`frameSent: true`, `hadPayload: true`), our action route redirected to Studio, the browser softphone rang, a human answered, and the screen pop rendered the transcript |
| **T15 Docker + Traefik** | **done, routed, ngrok retired, and proven on real traffic from an external handset.** Two containers on one public host split by path. A 72 s call: `/ws` upgraded, **4 voice turns in one trace**, `lookup_order` + `search_knowledge` + `handoff` + `end_call`, transferred to the softphone and **a human answered**; screen pop fetched through Traefik. SMS: **1 in → 1 reply**, 0 tool calls, from memory. Every layer measured — TLS chain byte-identical, `signedUrl` correct, runtime corp CA, Langfuse reachable *and exporting spans*, 184 s SSE hold, clean SIGTERM. Still unexercised: the **45 s drain** (needs SIGTERM mid-call) |

**Not started:** T16–T17 Traefik follow-ons, T18–T20 UI + docs.

**A human can talk to the agent three ways now**, and all three have been done for real — the bench
page, **text the number**, or **call it** and hang up by saying you're done. Since T14b there is a
fourth page, `/softphone`, which is not a way to talk to the agent but the place a caller **lands when
the agent gives them up** — open it before the call or the transfer rings nothing.

Since T15 each of those pages has **two** URLs, and which one you use matters:

| | host (`pnpm dev:all`) | container (`pnpm stack:up`) |
|---|---|---|
| pages | `http://localhost:3000/bench` | `https://northwind.twilio.dtolb.com/bench` |
| agent | `http://localhost:8910/health` | `https://northwind.twilio.dtolb.com/health` |
| how `/api` reaches the agent | Next's dev rewrite proxy | Traefik's path split |

**They are mutually exclusive for Twilio traffic**: `TWILIO_VOICE_PUBLIC_DOMAIN` points at exactly one
of them, so whichever is *not* repointed receives nothing. Running `pnpm dev:all` while the containers
are up is fine for the bench (no published-port clash — the containers publish none), but calls and
texts go to whichever host Twilio has been told about. `pnpm status` shows both and warns on a mismatch.

Still absent: the home page is a placeholder.

## Running it

```bash
pnpm status        # what's up, what's configured, what's therefore possible. Read-only.
pnpm langfuse      # the 6-container Langfuse stack (~2.7 GB, ready in ~10s on warm volumes)
                   # ⚠ if docker is dead, see "colima wedged" below BEFORE retrying — the retry
                   #   fails with an exit code of 0 and a fatal on stderr, which reads as success
pnpm dev:all       # agent :8910 + web :3000, ctrl-c stops both cleanly
                   # ⚠ the agent runs under --watch, so killing the :8910 LISTENER just respawns it.
                   #   Kill scripts/dev.mjs, the supervisor. And use `lsof -ti :8910 -sTCP:LISTEN` —
                   #   without -sTCP:LISTEN the list includes any tunnel and you take that down too.

pnpm stack:up      # THE CONTAINERS: preflight, then docker compose up -d --build
                   # NOT `pnpm up` — `up` is a built-in alias for `pnpm update` and a script cannot
                   #   shadow a built-in, so it would rewrite the pinned lockfile instead.
pnpm stack:down    # docker compose down
pnpm preflight     # refuses the stack on a bad APP_NAME, missing `edge`, unresolvable CORP_CA_PATH

pnpm typecheck && pnpm test
pnpm seed:prompts                    # push BOTH compiled defaults as a new version + `production`
pnpm seed:prompts demo-agent-voice   # just one — every run relabels what it touches, so prefer this

# the seven live diagnostics — each answers a question you cannot answer by reading code
node --env-file-if-exists=.env scripts/verify-memory.ts        # is memory ACTUALLY on; store baseline
node --env-file-if-exists=.env scripts/verify-knowledge.ts     # does the KB answer real questions
pnpm seed:knowledge                                            # push the Northwind articles (idempotent)
pnpm seed:studio                                               # publish the handoff flow, backing the
                                                               #   live revision to disk first

node --env-file-if-exists=.env scripts/repoint-public-host.ts <host>          # dry run
node --env-file-if-exists=.env scripts/repoint-public-host.ts <host> --write  # all 3 places at once

node --env-file-if-exists=.env scripts/verify-model.mjs        # is the key good, do tools fire
node --env-file-if-exists=.env scripts/verify-prompts.ts       # live version, and the fallback path
node --env-file-if-exists=.env scripts/verify-tools.ts         # catalog, resolver, live prompt names
node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-turn.ts
node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-telemetry.ts
```

`verify-turn.ts` is the one that matters most now: it drives **three real turns of one conversation**
— live Langfuse prompt, real catalog, real model — and prints the version, tools called, TTFT and
totals. It exits non-zero on a surprise, so it doubles as a smoke check.

Turn 2 is the assertion no other check in this repo can make. It asks *"what was the order number I
just asked about?"* — a question whose answer appears nowhere in the question, the system prompt or
any tool output — so a correct answer is proof the history store works. **An amnesiac agent passes
every other check in the suite**, because every one of them drives a single turn. Turn 3 repeats it
after `clear()` and requires the answer to be gone. Measured, both directions:

```
turn 1  2 tools, 2 steps, ttft 2278ms   history → 2 messages
turn 2  "A4721"                          historyMessages 2, 634 input tokens
        clear()
turn 3  "I don't have an order number from this chat."   historyMessages 0, 560 input tokens
```

The 74-token input gap between turns 2 and 3 is the retained exchange, which is also why the message
cap is a latency decision and not only a memory one.

The bench, now that it exists, is the fastest way to exercise a real turn:

```bash
pnpm dev:all     # then http://localhost:3000/bench — type and watch it stream
curl -sN -X POST http://localhost:8910/api/bench/turn \
  -H 'content-type: application/json' -d '{"text":"where is order A4721?"}'
```

Langfuse UI: <http://localhost:3100> — `demo@example.com` / `changeme-at-least-8-chars`.

### colima wedged: "vz driver is running but host agent is not"

`colima list` shows **Broken** and every docker command fails with
`dial unix …/docker.sock: no such file or directory`. **`colima stop && colima start` does NOT fix
this** — that was the guess recorded here previously and it was measured to fail on 2026-09-11. `stop`
reports "not running" and `start` re-emits the same fatal.

The real cause is a **stale pidfile whose pid has been recycled across a reboot**:

```bash
ls -la ~/.colima/_lima/colima/          # vz.pid present, ha.pid ABSENT → that asymmetry IS the message
ps -p "$(cat ~/.colima/_lima/colima/vz.pid)"   # some unrelated Apple process, not lima
mv ~/.colima/_lima/colima/vz.pid /tmp/ && colima start    # ~70 s, then docker works
```

Measured here: `vz.pid` dated Aug 27 held pid 1620, which after the Sep 10 reboot belonged to
`PlugInLibraryService`. Lima checks only that the pid is *alive*, finds a live stranger, and concludes
its driver is running forever. Verify the pid is not lima's before moving the file, and never touch the
21 GB `disk` image next to it. The six Langfuse containers came back automatically on VM start.

`.env` has a real `OPENAI_API_KEY`, local Langfuse config, and — since T12 — real Twilio credentials
including `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` and `TWILIO_CONVERSATION_CONFIGURATION_ID`, so
**SMS works**. Since T13 `TWILIO_VOICE_PUBLIC_DOMAIN` is set as well, so `capabilities().voice` is
true and voice boots — it was the only variable SMS did not need. **Since T15 its value is the stable
Traefik host `<APP_NAME>.twilio.dtolb.com`, not an ngrok host.** Since T14
`TWILIO_KNOWLEDGE_BASE_ID` is set too, so `capabilities().knowledge` is true and `search_knowledge` is
a real tool. **Since T14b `TWILIO_STUDIO_HANDOFF_FLOW_SID` is set as well** — it was absent from `.env`
right up until T14b.9, which is why `/health` reported `handoff: false` through eight tasks of building
handoff — so `capabilities().handoff` is true and the `handoff` tool resolves.

⚠ **What this file used to say here was wrong, and it was wrong in the confident direction.** The old
text said that with the flow SID set, TAC repoints the ConversationRelay `action` at Studio, and that
T14b's answer was to pin `actionUrl` in `VOICE_TWIML_OPTIONS` — *"so the two can coexist."* The
precedence claim is true and measured (`defaultTwimlOptions` is layer 2 of five and nothing sits
between it and Studio's layer 4). **The conclusion is false.** `/conversation-relay-callback` is
**TAC's own route**, registered unconditionally; its handler answers
`{status: 200, content: "OK", contentType: "text/plain"}` and **never TwiML**; and
`ConversationRelayCallbackPayloadSchema` has **no `HandoffData` field**, so being a plain non-strict
`z.object` it **strips** it. Pinning `actionUrl` at TAC's own path would have kept the POST arriving
while silently discarding the handoff and then dropping the call. Coexistence required pinning a **new
path this repo owns** — `POST /api/voice/relay-action` — and returning routing TwiML there. Also note
the const is gone: it is now `buildVoiceTwimlOptions(publicDomain)`, a function, because the second key
depends on the public host. Note the shell also exports real
`TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET` from the user profile, so those three read
as present whatever `.env` says — a clone on another machine behaves differently.

**Inbound SMS needs a public URL, and since T14 there is one command for it.**
`scripts/repoint-public-host.ts <host> --write` updates all three places that must agree —
`TWILIO_VOICE_PUBLIC_DOMAIN`, the number's `voice_url`, and the CO `statusCallbacks[0].url` — backing
the configuration up and re-reading the backup BEFORE the full-replace PUT, then diffing afterwards to
prove nothing else moved. ~~**Reserve a static ngrok domain** and this chore disappears until T15.~~

**Superseded at T15: ngrok is retired, and the chore is gone rather than reduced.** The public host is
now the Traefik dev box's `<APP_NAME>.twilio.dtolb.com`, which survives restarts, so there is nothing
to repoint on a reboot. Run the stack with `pnpm stack:up`. The repoint script still matters — for the
one-time move onto this host, and for moving off it — and the mechanism below is unchanged: the CO
configuration's `statusCallbacks[0].url` is baked in, and updating it is a **full-replace PUT** where
every omitted field is deleted.

`preflight` and `pnpm status` both now warn if `TWILIO_VOICE_PUBLIC_DOMAIN` drifts away from
`<APP_NAME>.twilio.dtolb.com`, so provisioning a tunnel here would be flagged, not silently accepted.

## Corrections to the plan — all three fail silently

Verified against the installed packages in `node_modules`, not inferred. Do not re-derive these.

### 1. `experimental_telemetry.metadata.langfusePrompt` does not exist on `ai@7`

The plan's S1 note says to pass `p.toJSON()` there. `TelemetryOptions`
(`node_modules/ai/dist/index.d.ts`) has **no `metadata` field at all**, and `experimental_telemetry`
is deprecated in favour of `telemetry`. The prompt→trace link must ride on
**`runtimeContext.langfusePrompt`** with **`includeRuntimeContext: { langfusePrompt: true }`**, and it
must be a **plain object** — `@langfuse/vercel-ai-sdk`'s `normalizePrompt` requires
`isPlainObject(value) && typeof value.name === 'string' && typeof value.version === 'number'`, so
`toJSON()`'s **string** is discarded with no warning and the Metrics tab stays empty.

`langfusePromptLink()` in `server/agent/model/openai.ts` is the working shape. `ResolvedPrompt`'s
`telemetryLink` comment points at it.

### 2. `@langfuse/tracing` discards top-level custom span attributes

`createObservationAttributes` destructures a fixed key set (`metadata`, `input`, `output`, `level`,
`statusMessage`, `version`, `environment`, `completionStartTime`, `model`, `modelParameters`,
`usageDetails`, `costDetails`, `prompt`). A top-level `'turn.ttft_ms'` is never read. Everything
custom nests under **`metadata`**, where `_flattenAndSerializeMetadata` emits
`langfuse.observation.metadata.<key>` preserving the key verbatim.

Its guard is `if (serialized)`, not `!= null`, so `false` and `[]` survive but **`null` is dropped** —
`prompt.label` on a fallback is an absent key, not a null one.

### 3. A turn SPAN cannot carry a prompt-version link — this limits the headline feature

Langfuse v4's ingestion computes `promptName` only when the observation type is **GENERATION**.
Confirmed by reading ClickHouse `events_core` directly: `turn.bench` has `prompt_name=''` while the
`chat gpt-5.4-mini` GENERATION carries the resolved link.

So **per-prompt-version latency aggregation works at the model-call level** — which is where a prompt
change actually bites, and Langfuse renders a native Time To First Token column there. But
`turn.ttft_ms` and `turn.total_ms` live on the turn span, which is filterable by
`prompt.name`/`prompt.version` metadata but gets **no native per-version aggregation**.

The feature is **degraded, not absent** — describe it that way. `run-turn.ts` keeps the (currently
inert) `span.update({ prompt })` with the measurement recorded at the call site, so it lights up if
Langfuse's ingestion changes. Unexplored alternative, deliberately not taken: `@langfuse/tracing`
supports `startObservation(name, attrs, { asType: 'generation' })`, which would make the link stick —
at the cost of labelling a turn as a model call, in a helper T13 also uses.

## The finding that still matters most

**`LangfuseSpanProcessor` silently drops raw OpenTelemetry spans.** It only forwards spans passing
its `isLangfuseSpan`/`isGenAISpan` filters. A span from `trace.getTracer(x).startActiveSpan(...)` is
created correctly — an in-memory exporter sees it, it has a real sampled trace id — and never reaches
Langfuse.

**Always** create spans via `server/obs/spans.ts`. Related: `trace.getTracerProvider()` returns a
`ProxyTracerProvider` with **no** `forceFlush`, so `.forceFlush?.()` is a silent no-op. Flush via
`.getDelegate()` — `flushTelemetry()` does.

## Verified waterfall (Langfuse UI, via Playwright MCP)

This is a real tree, confirmed in the UI **and** against ClickHouse `events_core.parent_span_id`:

```
conversation.bench                     SPAN     is_app_root = true, no parent
└─ turn.bench                          SPAN     11 attributes, all exact names
   ├─ prompt.fetch          0.04s      SPAN     cache hit ≈ 0ms, which is the point
   ├─ memory.recall                    SPAN     concurrent with prompt.fetch
   ├─ prompt.compose                   SPAN
   ├─ tools.resolve                    SPAN
   ├─ llm.stream            4.15s      SPAN     ⟵ SIBLING of invoke_agent, not its parent
   └─ invoke_agent gpt-5.4-mini        AGENT    the AI SDK emits these free
      ├─ step 1                        SPAN
      │  ├─ chat gpt-5.4-mini          GENERATION  + native TTFT column
      │  └─ lookup_order               TOOL
      └─ step 2                        SPAN
         └─ chat gpt-5.4-mini          GENERATION
```

⚠ **`llm.stream` does NOT parent the model call, and earlier revisions of this file drew it that way.**
Corrected 2026-09-11 by reading `parent_span_id` directly: on both the bench and SMS traces,
`invoke_agent` names the **turn** span as its parent, exactly like `prompt.fetch` does. The cause is
in `obs/spans.ts`: `startStep` uses `startObservation`, which creates an observation **without making
it the active context**, so the AI SDK's spans parent to whatever *is* active — the turn span from
`startActiveObservation`. So `llm.stream` is a *timer running alongside* the model call, not a
container for it, which is why its duration and `invoke_agent`'s are near-identical rather than nested.

Harmless today, and deliberately left alone: the property that actually matters is that the model
calls sit inside their own **turn** span, which they do. But do not describe the waterfall as
`llm.stream > invoke_agent`, and do not write an assertion that expects that nesting. Making it real
would mean `startActiveObservation` for `llm.stream`, which the `{tokens, done}` split rules out —
the step outlives the call that creates it (see `run-turn.ts` on why `startStep` earns its place).

Span names are OTel GenAI-convention, **not** `ai.*`. Anything keying on `ai.streamText` (v6 naming)
finds nothing.

The same shape, driven from the `/bench` page in a browser — two turns, one trace, screenshot-confirmed:

```
conversation.bench                     1m 19s   open until swept or shutdown
├─ turn.bench                          2.10s
│  └─ llm.stream → invoke_agent → chat gpt-5.4-mini ×2   464→53, 626→77   tool loop, 2 steps
└─ turn.bench                          0.59s
   └─ llm.stream → invoke_agent → chat gpt-5.4-mini ×1   563→7            answered from history
```

The model calls sitting **inside** their own `turn.bench` is the property the `withTurnSpan`-wraps-the-
drain rule buys; `tests/bench-route.test.ts` asserts it on a sequence counter, and that assertion was
confirmed to bite by moving the drain out.

## Layout

```
server/
  index.ts          resolve config, report it, then ONE of two boot paths — TAC listens, or we do.
                    Owns the single `preClose` cleanup hook. Read its comments before editing.
  config.ts         Zod env → capability flags. NEVER THROWS. The one place env is read.
  logging.ts        the ONE pino instance (+ LogLayer view). Children inherit PII scrubbing.
  agent/
    types.ts        TurnInput/TurnOutput/TurnResult/TurnDeps + ports. ZERO vendor imports.
    run-turn.ts     THE core. Channel-agnostic. Read its header before editing.
    spans.ts        the production TurnSpans adapter over obs/spans.ts
    deps.ts         createTurnDeps — the live ports, shared by the bench AND SMS
    memory.ts       passthroughMemory — what the BENCH uses. TAC's real port is in twilio/
    history.ts      bounded per-conversation transcript. Caps + eviction policy in its header.
    prompt/         port.ts · langfuse.ts · defaults.ts · slots.ts
    tools/          registry.ts · catalog.ts · resolve.ts
    model/          port.ts · openai.ts  (the ONLY file importing `ai`)
  http/
    app.ts          buildApp(deps). Testable without a socket. /api/dev/emit-turn lives here.
    sse.ts          SseHub: heartbeat, drop-on-throw, transport-agnostic
    routes-obs.ts   GET /events/stream (SSE) + /events/recent
    routes-bench.ts POST /api/bench/turn. MUST NOT import TAC — that rule is the whole point.
    routes-voice-action.ts  POST /api/voice/relay-action — the `<Connect action>` URL, and the ONE
                    place a call is routed. Returns valid TwiML on EVERY path, bugs included.
    routes-handoff.ts  GET /api/handoff/context (the screen pop) + POST /api/voice/token. Imports NO
                    vendor: `mintToken` is INJECTED from index.ts, which is what keeps `twilio` inside
                    server/twilio/ and out of a credential-free process.
  handoff/
    snapshots.ts    the bounded screen-pop store. Imports nothing but shared/, deliberately — voice.ts
                    writes it and http/ reads it, so a vendor import here would drag TAC into http/.
  twilio/           the ONLY dir allowed to import twilio-agent-connect
    tac.ts          bootTac — ONE function, both channels, because there is only one TACServer.
                    SMS: registerChannel BEFORE new TACServer or /webhook is never registered.
                    Voice: passed to TACServer and NEVER registered, or our prompt slot is replaced.
                    Also owns the fastify-graceful-shutdown registration — read that constant.
    messaging.ts    one inbound SMS → runTurn → the reply string. Never throws, never returns ''.
    memory-compose.ts  THE TAC memory port. Makes the communications section structurally
                    unreachable — read its header before touching it. Imports TAC STATICALLY, so it
                    must be reached only from tac.ts.
    builtin-tools.ts   TAC's built-ins as ToolDefs, Zod mirrors + drift tests, constructed LAZILY
                    inside execute. Closes over `tac`, which is why ToolCtx needs no TAC handle.
    voice.ts        one ConversationRelay turn → runTurn → tokens spoken as they arrive. Owns the
                    end-session frame, which is how the agent hangs up — and since T14b the handoff
                    frame, which is how it gives the caller away. Read its
                    header: every failure mode on this channel is silence.
    handoff.ts      the `handoff` ToolDef wrapping TAC's `createStudioHandoffTool`. Records an intent
                    and lets TAC PARK a ready-made frame; sends nothing. voice.ts drains it.
    voice-token.ts  AccessToken + VoiceGrant for the softphone. The ONLY file importing `twilio`.
  obs/
    instrumentation.ts  --import preload. NodeSDK + LangfuseSpanProcessor + registerTelemetry.
    spans.ts            THE span API. Read its header before touching telemetry.
    first-token.ts      TTFT. Pure, fake clock. `collect()` here is what SMS uses.
    bus.ts              never throws on the product path; scrubs payloads once, at the boundary
    pii.ts              our own scrubber. Ancestor-path cycle detection + a depth bound.
    conversations.ts    per-conversation trace roots, swept + capped. Bench and SMS share it, and for
                        SMS it is the traceparent carrier IN PREFERENCE to TAC's session.metadata.
shared/               types + pure constants ONLY. Compiled by BOTH tsconfigs.
                      tac-tool-names.ts — the ONE source of truth for the TAC-provided tool
                      names, because builtin-tools.ts imports TAC and agent/ may not. ⚠ APPEND ONLY:
                      indices 0/1 are read positionally by builtin-tools.ts and 2 by twilio/handoff.ts.
                      handoff.ts — CLIENT_IDENTITY, the three route paths, the screen-pop types.
web/                  Next 16 + Strix. Own package.json, own lockfile, own .npmrc.
                      src/app/softphone/ — the browser agent. One client island that dynamically
                      imports @twilio/voice-sdk, registers, rings, screen-pops and answers.
tests/                vitest. No mocking library, no snapshots — injection instead.
                      helpers/ is NOT collected (vitest.config.ts includes only tests/**/*.test.ts) —
                      helpers/fake-tac.ts is shared by the handoff and voice suites.
scripts/              status · dev · seed-prompts · seed-knowledge · knowledge-articles
                      repoint-public-host (all 3 host places at once, with a verified backup)
                      studio-handoff-flow (the committed flow DEFINITION) · seed-studio-flow
                      verify-{model,prompts,tools,turn,telemetry,memory,knowledge}
```

### Who owns the turn span — the thing most likely to be got wrong

**`runTurn` does not create the turn span. Its caller does, and passes it on `TurnInput.span`.**

Forced, not stylistic. `withTurnSpan(name, traceparent, fn)` ends its observation when `fn` settles,
but `runTurn` returns `{tokens, done}` and the caller drains `tokens` afterwards — so a turn span
created inside `runTurn` would close before the model streamed a token, putting every AI SDK span in
a different trace. The caller must wrap the **entire** handler, including the drain, and `runTurn`
must never call `span.end()`.

**`tokens` must be consumed before the caller's next `await`.** Not merely "promptly" — the drain race
gets one macrotask of grace, and a caller that awaits something slower between receiving `tokens` and
its first `next()` gets `ttftMs`/`totalMs` as `null` while the caller still hears the whole answer.
T13's voice handler is exactly the code that tends to acquire an `await` there.

### How history is shaped, and the two decisions inside it

`server/agent/history.ts`. Bounded on **both** dimensions, because a demo box runs for a week:
`HISTORY_MAX_MESSAGES = 20` (ten exchanges, even on purpose — turns are appended as a pair) and
`HISTORY_MAX_CONVERSATIONS = 200`.

- **Messages evict oldest-first. Conversations evict least-recently-USED** — used, not written, so
  `read` refreshes recency. Recency-on-write-only would evict the conversation whose next turn is
  already in flight, i.e. the live call, and the symptom is an agent forgetting mid-call only under
  load only on a long-lived box. A test asserts the read path specifically; it was proven to bite.
- **A dropped conversation warns; a trimmed message does not.** Deliberate asymmetry — trimming is
  steady state and a line per turn would bury the one that matters.
- **`TurnDeps.history` is REQUIRED, not optional.** An optional port defaults to an amnesiac that
  passes every single-turn test. Making it required turned the omission into a compile error, which
  is exactly what happened to `scripts/verify-turn.ts` when the field landed.
- **RATIFIED PRODUCT DECISION — an aborted turn keeps its partial answer.** On voice the caller heard
  those words, so dropping them lets turn 2 contradict what the room remembers. Note this text cannot
  come from `TurnResult.text`: `ai@7` rejects its result promises on a barge-in with no completed
  step, so `runTurn` reports `text: ''` there **by design and still does**. The partial is therefore
  accumulated in `runTurn`'s own `observed()` generator — deliberately not in `withFirstTokenMark`,
  whose docblock promises it measures "without buffering the stream to measure it". An *empty* answer
  is still not stored: the question is recorded, an assistant message is not.
- A turn that fails outright leaves history untouched — the caller speaks a fallback and the human
  nearly always repeats themselves, which would otherwise store the utterance twice.

The read costs nothing measurable, so it deliberately has **no span of its own** — a `history.read`
row reporting 0.00 ms every turn implies a cost it does not have. It reports `historyMessages` on
`prompt.compose` instead, which is the number that answers "did it remember?" and explains why a
turn-20 prompt costs more than a turn-2 one. Make it a span if it ever becomes I/O.

### The bench, and the two bugs it produced

`POST /api/bench/turn` (the `BENCH_TURN_PATH` constant) streams SSE frames — `start`, `token` per
delta, then exactly one of `done` or `error` — and `/bench` renders them with Strix
`ChatLog`/`ChatInput`. The old `POST /api/turn` 501 placeholder is **gone**.

**Tokens ride the request's OWN response, not the obs SSE hub**, which is a deliberate departure from
the original plan wording. The hub broadcasts to every console and every publish lands in the bus's
500-entry ring buffer that `/events/stream` replays. A 206-character answer is ~40 deltas, so a dozen
turns would evict every lifecycle event, each new console would replay hundreds of token fragments,
and two `/bench` tabs would interleave each other's answers. The SSE primitives (`formatSse`,
`SSE_HEADERS`) are reused, so there is one wire format. **This stream is the answer; the obs hub is
the commentary** — `runTurn` still publishes the same events voice will.

**Two bugs worth knowing about, because both were invisible at the layer they were written in:**

1. **`request.raw.on('close')` fires on a POST as soon as the request body is consumed** — measured at
   **+3 ms** against a client that stayed connected 905 ms. Every bench turn aborted before its first
   token while HTTP looked perfectly healthy: 200, correct SSE headers, a `done` frame with
   `aborted: true`, no tokens, null timings. On a **GET** it fires at the end of the response
   (+906 ms), which is why the identical line in `routes-obs.ts:57` is correct and this one was not.
   Use `reply.raw`. The `SseSink` unit tests could not catch this — they pass an `AbortSignal`
   straight in and skip the Fastify adapter — which is why `tests/bench-http.test.ts` exists and
   drives a real socket.
2. **`ChatLog` has no horizontal padding and takes no `className`.** Its root is
   `flex flex-col gap-gap-400 min-h-0 w-full overflow-y-auto`, and a `side: 'end'` message is a
   `flex-row-reverse` row whose author is `shrink-0 min-w-14`. Flush against a bordered container,
   "You" rendered as "Yo" on every one of the reader's own messages. The padding has to live on the
   wrapper. **Invisible in a DOM snapshot and in every assertion; obvious in a screenshot** — which is
   the general lesson, not a Strix quirk.

Also: `Typography` has **no `body-s-regular` or `body-xs-regular`** — the real names are `body-s` and
`body-xs` (`body-m-regular` does exist, which is what makes the guess plausible). This one is a type
error, so `tsc` catches it.

**Dev vs prod origin.** `web/next.config.ts` rewrites `/api`, `/events` and `/health` to
`AGENT_DEV_ORIGIN` in development only. So browser code fetches **relative** paths and is identical in
both environments — in production Traefik path-splits to the agent container on the same host. The
alternative needed CORS (a JSON POST is preflighted) plus a second code path. **Verified the rewrite
does not buffer the stream**: `start` at t+0, first token at t+2.0s, then deltas every ~50 ms. A
buffering proxy would look exactly like a slow model.

**A bench conversation's root span stays open until swept or shut down.** The bench has no disconnect
signal — a closed tab tells the process nothing — so `createConversationRegistry` sweeps on a 30-minute
idle TTL, caps at 50, and `index.ts` calls `bench.shutdown()` **before** `flushTelemetry()`. That order
matters: an unended span never reaches Langfuse, so flushing first ships every turn while dropping the
conversation they hang from. The practical consequence during a demo is that turns appear in Langfuse
promptly while their `conversation.bench` parent arrives when the conversation ends.

## Twilio credentials — the method, and two things that mislead

`.env.example` is the authoritative per-variable reference: Console location, format, and what breaks
without each one. It is committed and a test fails if the code reads a variable it does not describe.
What follows is only what that file cannot tell you — how to *check* a value before the app depends
on it, verified by running each command.

**Verify credentials with `twil`, not with this app.** When a channel misbehaves you want to be
debugging one thing, not two. All of these are read-only; none place a call or send a message.

**Use `twil` (`~/bin/twil`) — the official `twilio` CLI is UNINSTALLED.** It never covered
Conversation Orchestrator or memory stores, which is why earlier revisions of this table fell back to
raw curl for those two rows. `twil-ask` is the same binary for **mutations**: it bypasses the
interactive-TTY gate and raises a permission prompt instead. `twil docs` is also the documentation
source — search it before diagnosing any Twilio error, rather than reasoning from memory. Don't
confuse `twil` with `twl`, the Raspberry Pi deploy CLI.

| Question | Command |
|---|---|
| Which credentials is the CLI even using? | `twil profiles list` |
| Do the key and secret authenticate? | `twil api core incoming-phone-numbers list` |
| What is my `TWILIO_PHONE_NUMBER`? | same — JSON is **snake_case** (`phone_number`, `sms_url`, `capabilities`) |
| Do I have a CO configuration? | `twil api conversations configurations list` |
| Which memory store? | `twil api memory stores list` |
| Which Studio flow for handoff? | `twil api studio flows.v2 list` — bare `flows` is **not** a command; needs status `published` |
| Is the number 10DLC-registered? | `twil api messaging services list`, then `… services phone-numbers list --service-sid MG…` |
| Is the auth token good? | `twil webhook invoke` at the running app — a **403** means the token is wrong, and it costs nothing |

### 1. `accounts list` 401s on a good key — and it is the KEY, not the CLI

The obvious "are my credentials working" command returns **HTTP 401, error 70004** — *"the provided
key does not have the permissions to access this endpoint"* — against a **restricted** API key, while
the same key lists phone numbers fine. Measured on this account, and it reads as *"my credentials are
wrong"*, which sends you rotating keys that were never the problem.

Re-confirmed under `twil`: `twil api core accounts list` returns the same 70004 **even with
`--profile Dtolb-Twilio`**, while `twil api conversations configurations list` succeeds. Changing CLI
does not help — prove credentials with an endpoint that works.

### 2. Three Twilio variables are exported by the shell profile on this machine

`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` and `TWILIO_API_SECRET` come from the user profile, so they read
as **present** in `pnpm status` and `/health` whether or not they are in `.env`. Only the other four
show as missing. Real, not a bug — but `.env` is not the whole picture here, and a clone on another
machine will behave differently. Also worth knowing: the auth token is *not* interchangeable with the
API key, and it is the value that validates inbound webhook signatures, so a stale one produces
`Invalid Twilio webhook signature` on every request and looks like a Twilio outage.

### The order things actually gate in

`TWILIO_CONVERSATION_CONFIGURATION_ID` is the consequential one: without it TAC runs voice-only and
Memory, Knowledge **and** handoff are all absent (`getMemoryClient()` returns null). A CO configuration
with no `memoryStoreId` gives you SMS but no Conversation Memory, so check that field rather than
assuming. `TWILIO_VOICE_PUBLIC_DOMAIN` is a **bare host, no scheme**, and `TACServer` throws at
construction without it.

**As of T12 these are live, not preparation.** `TWILIO_CONVERSATION_CONFIGURATION_ID` and
`TWILIO_PHONE_NUMBER` are read into the SMS channel at boot, and `capabilities().sms` gates on both.
`TWILIO_VOICE_PUBLIC_DOMAIN` and `TWILIO_STUDIO_HANDOFF_FLOW_SID` were still unread then — and
note SMS does **not** need the voice domain, which the plan assumed it would. **Both are live now:** the
domain since T13, the flow SID since T14b, where it also became the gate on `capabilities().handoff`.
⚠ The domain must be a bare host with **no scheme and no trailing slash**; `server/config.ts` rejects
the scheme and not the slash, so `buildVoiceTwimlOptions` strips it — see T14b below for what a stray
`/` used to cost.

## T12, TAC boot for SMS — what was built, and the nine ways the plan was wrong

New: `server/twilio/{tac,messaging}.ts`, `server/obs/conversations.ts`, `server/agent/deps.ts`.
Changed: `server/index.ts`, `server/http/app.ts`, `server/config.ts`, `server/http/routes-bench.ts`.

**How an inbound SMS reaches us — this is the part most likely to be assumed wrong.** Not the phone
number's `sms_url`, and not a Messaging Service inbound webhook. It is the **Conversation Orchestrator
configuration's `statusCallbacks[].url`** pointing at `POST /webhook`, plus **bidirectional**
`channelSettings.SMS.captureRules` binding the number (`{from:'*',to:NUMBER}` and
`{from:NUMBER,to:'*'}` — the outbound rule is what threads our reply back into the conversation).
Proven by flight-sandbox, whose working number sits in a Messaging Service with an *empty* inbound
webhook. TAC's `/webhook` expects a CO **event envelope**, not a Twilio form POST; send it the wrong
shape and you get `200` plus `Unhandled event type` and total silence. Editing an existing CO
configuration is a **full-replace PUT** where every omitted mutable field is deleted.

Nine corrections to the approved plan, each verified by executing it against the installed 2.2.0:

1. **`TWILIO_VOICE_PUBLIC_DOMAIN` is NOT required for SMS.** `TACServer`'s guard is
   `voiceChannel && !voicePublicDomain`, and `voiceChannel` is undefined when none was registered.
2. **Use `new TACConfig({...})`, not `TACConfig.fromEnv()`.** `fromEnv()` reads `process.env`, which
   would be a *second* place the environment is read. The constructor takes values directly. Pass
   `voiceWebsocketPath`/`voiceActionPath`/`voiceCallEventPath` as **`undefined`** — they are
   `z.preprocess` wrapping `.default()`, so the key is required while a value is not.
3. **`server/config.ts` now validates the CO id and Flow SID shapes**, because TAC re-validates both
   and throws a raw `ZodError` at construction. `conv_configuration_` + **26** lowercase alphanumerics;
   `FW` + 32 **lowercase** hex. A typo'd value would otherwise report `sms:true` and then kill boot.
4. **`TAC.create()` MAKES A NETWORK CALL** (GETs the CO configuration) and rethrows, so it sits on the
   boot path and can fail for reasons outside the process. It is wrapped; failure logs loudly and falls
   through to `app.listen()` so `/health` and `/bench` survive.
5. **`TACServer.start()` calls `listen()` itself**, so `server/index.ts` has two mutually exclusive
   boot paths and only one of them calls `app.listen()`.
6. **Shutdown uses `preClose`, NOT `onClose`, and NOT TAC's `gracefulShutdown` callback.** This
   contradicts plan footgun #9 and it matters: avvio's `onClose` queue is **LIFO**
   (`_closeQ.unshift`), and fastify registers its own server-closing hook *later*, so ours would run
   **last** — after `server.close()`. But `obs.shutdown()` is what ends the SSE responses
   `server.close()` is waiting on, so it deadlocks against itself. `fastify-graceful-shutdown`'s 10 s
   watchdog then `process.exit(1)`s and **the telemetry flush never runs**. `preClose` runs inside
   fastify's internal onClose, *before* `server.close()`, and is FIFO. `forceCloseConnections: true`
   was added for the same reason — `keepAliveTimeout` is 72 s and Next's dev rewrite proxy holds a
   socket open on every `/bench` visit.
7. **`registerChannel(smsChannel)` MUST precede `new TACServer(...)`.** The constructor *snapshots*
   channels and `setupRoutes` registers `/webhook` only `if (webhookChannels.length > 0)`. Wrong order
   → inbound SMS 404s with nothing but `No channels configured for webhook processing`.
8. **SMS gets NO `abortSignal` from TAC** — only voice's `prompt` path supplies one. We synthesize
   `AbortSignal.timeout(SMS_TURN_TIMEOUT_MS)`, because an unbounded turn leaves `llm.stream` unended
   and an unended span never reaches Langfuse. **And abort must be handled differently from voice:**
   `runTurn` keeps a partial answer because *on voice the caller heard those words*. On SMS nothing was
   delivered, so sending the partial would text the customer a sentence that stops mid-word. An
   aborted SMS turn therefore sends the fallback and publishes an `error` — on SMS, `aborted` can only
   mean our own timeout.
9. **`memoryMode: 'never'` at T12 — and ⚠ THE REASON GIVEN HERE WAS FACTUALLY WRONG.** Corrected at
   T14, and worth reading rather than skipping, because the wrong version was specific enough to be
   believed for two whole tasks.

   This said that with `'always'` TAC "folds a `## Recent Message History` block" that duplicates
   `server/agent/history.ts`. **TAC folds nothing.** `MemoryPromptBuilder` has ZERO callers anywhere
   inside TAC — grep it and `.compose(` across `packages/` at 2.2.0. `memoryMode` decides exactly one
   thing: whether, and how often, Recall is called. The `TACMemoryResponse` is handed to our callback
   and what reaches the model is **entirely our compose port's decision**.

   So the duplication could never have happened on its own; it needed us to pass the communications
   through. `'never'` was still a defensible T12 choice — `composeMemory` was the passthrough, so a
   Recall was fetched and discarded — but for that reason, not this one.

   Since T14: **SMS runs `'always'`, voice runs `'once'`**, and
   `server/twilio/memory-compose.ts` makes the communications section structurally unreachable — its
   input schema has no `communications` key so zod strips them, and the response it hands the renderer
   is constructed with `communications: []`. That covers a case no config value can: on a Recall
   failure TAC falls back to `listCommunications(conversationId)` with **no limit** and would render
   this very conversation.

Also worth knowing: **`onMessageReady` lives on `TAC`, not on the channel** — single-slot and global
across channels, so T13 must branch on `channel` rather than registering a second one. Returning `''`
is a silent no-reply (`Callback returned empty string, skipping auto-send`), and a thrown error is
caught and only logged, so `handleInboundMessage` never throws and never returns `''`. Four other
things can drop an inbound SMS and **all of them log rather than raise**: idempotency-token dedup, the
`lastCommunicationId` guard, participant-reconciliation failure (`dropped_inbound: true`), and the
`author.channel` filter.

**The `webhook.inbound` diagnostic in `http/app.ts` is the highest-value fifteen lines here.** The most
likely first-SMS failure is a 403 on signature validation, which TAC reports as one `log.warn` with no
obs event — indistinguishable from a Twilio outage. The hook publishes the **exact URL TAC signs
against** (rebuilt from `X-Forwarded-Proto`, defaulting to `https`, then `X-Forwarded-Host`/`Host`).
Nothing on the bus → CO is not calling us, so the configuration is wrong, not the code. A 403 with a
URL → the URL says which half is wrong.

### What the live run actually proved, and two things it corrected

- **Conversation Orchestrator signs with the JSON path.** Every inbound arrived as
  `POST /webhook?bodySHA256=<sha256 of body>`, so TAC takes the `validateRequestWithBody` branch
  against `request.rawBody` — which only exists because `start()` installs the parser that stashes it.
  Do not "simplify" that parser away.
- **Our own outbound reply comes back to us as another `webhook.inbound`.** That is the *outbound*
  capture rule (`{from: NUMBER, to: '*'}`) working as intended, not a loop. TAC's
  `isDefaultAgentAddress` filter is what stops the agent answering itself, and it compares against
  `TACConfig.phoneNumber` — so a wrong-but-present number there would make the agent reply to its own
  messages. Nothing validates its shape inside TAC.
- **A signed simulated webhook is a genuinely free pre-flight.** `twil webhook invoke --type sms <url>
  --auth-token <token>` returned **200** and was then rejected by TAC on payload *shape*
  (`Invalid webhook payload`) rather than on signature. That is a pass: it proves the route, the
  preHandler, and the auth token together, before spending anything. Note `--auth-token` is
  **required** — the CLI profile holds an API key, and Twilio signatures use the account auth token.
- **The new CO configuration has `memoryExtractionEnabled: false`.** Irrelevant at T12
  (`memoryMode: 'never'`), but T14 must flip it or Conversation Memory will silently extract nothing.

### T12: what is left

1. ~~Langfuse trace tree for SMS~~ — **DONE 2026-09-11**, see the tree near the top of this file.
2. ~~Re-run the TAC-free proof~~ — **DROPPED by decision, 2026-09-11.** Not "not done": Dan ruled that
   the project works *with* TAC and that maintaining a TAC-free property is not worth the complexity it
   was pulling in. The claim as recorded under "Gaps and honest limits" stands as a statement about the
   run made at T11; it is **not** maintained going forward, and nothing should be relocated or added to
   keep it true.
3. **The ngrok host is baked into the CO configuration's `statusCallbacks`.** It dies on ngrok restart,
   and fixing it means a full-replace PUT. Repoint per session until T15 gives a stable host. As of
   2026-09-11 the tunnel is unchanged and the configuration still points at it, so no PUT was needed —
   confirm with the GET below before assuming one is.

### Two things about the CO configuration you will want on the next session

The endpoint is **not** in `twil`'s command surface for writes — `twil api conversations configurations`
has CREATE / FETCH / LIST / REMOVE and **no update** — so a repoint is a raw `PUT`. The base URL is not
guessable either; `--log-level debug` prints it:

```bash
twil api conversations configurations fetch --sid conv_configuration_… --log-level debug   # → the URL
# DEBU → method=GET url=https://conversations.twilio.com/v2/ControlPlane/Configurations/conv_configuration_…
```

`twil … fetch` renders only `id` and `displayName` even with `--output json`, so **GET it with curl (or
`fetch`) when you need the whole body** — which you always do before a full-replace PUT.

**`onConversationEnded` fires on a `CONVERSATION_UPDATED` webhook, not a `CONVERSATION_CLOSED` one.**
Measured: with `statusTimeouts.closed: 5` the only event types that ever arrived were
`CONVERSATION_CREATED`, `PARTICIPANT_ADDED`, `COMMUNICATION_CREATED` and — 300 s after the conversation
was *created* — one `CONVERSATION_UPDATED`, in the same second as the root span ending. So the status
rides *inside* an UPDATED envelope; grepping logs or code for `CONVERSATION_CLOSED` finds nothing. Note
the 300 s ran from creation, not from the last message, on this one sample.

**Ask before running anything that places a real call or sends a real SMS** — those are billed, and
the standing convention in this repo is not to do it unprompted.

## T13, TAC boot for VOICE — built, and what is actually proven

New: `server/twilio/voice.ts`, `tests/voice.test.ts`. Changed: `server/twilio/tac.ts`
(`bootTacSms` → **`bootTac`**, one function for both channels because there can only be one
`TACServer`), `server/index.ts`, `server/http/app.ts`. New dep: `fastify-graceful-shutdown@^5.0.0`.

**Path B, as ratified:** the `VoiceChannel` is passed to `TACServer` and **never registered**. Proof
it worked is in the boot log — exactly one `Registering channel` line, `channel: sms`, while TAC still
logs the three `call_event_callbacks` that only appear when a voice channel resolved.

### What two real calls proved

```
call 1  5 turns, ONE conversation.voice trace, all five turn.voice spans inside it
        turn 2 "what was that order number again?"  → 1 step, 0 tools   ← from history, not a tool
        turn 3 "actually what's the status?"        → lookup_order{A4721} from a question with no number
        2 barge-ins, real utteranceUntilInterrupt ("and it's due Friday, September eleventh.")
        ttft 2405 → 1077 → 1489 → 509 → 463 ms as the prompt cache warmed
call 2  end_call fired: tool at 18:14:46, farewell "Goodbye." streamed, frame at 18:14:49.448,
        socket closed 18:14:51.194 — the agent hung up, and the goodbye was heard first
        also exercised live: lookup_order{A4832} → found:false, and a 230 ms barge-in
```

TTFT on voice is much better than T9's 3.3 s measurement suggested — a warm turn lands around
500–800 ms. The slow ones are the first turn of a call and any turn that makes a tool round-trip.

### Proven for free, before any call — the pre-flight worth repeating on every new tunnel

```
/health                      wired: {tac: "sms+voice", voice: "ready"}, caps.voice true, caps.sms still true
GET  /ws        (ngrok)      404, 0 bytes   ← the HEALTHY answer for a non-upgrade request, not a bug
POST /twiml     unsigned     403 {"error":"Invalid webhook signature"}
POST /conversation-relay-callback unsigned  403
POST /twiml     SIGNED       200 + valid TwiML  ← `twil webhook invoke --type voice --auth-token …`
SIGTERM                      "Received shutdown signal" → "TAC shutdown complete"
                             → "sse hub shut down" (our preClose RAN) → exit 0, not the watchdog's exit 1
```

The signed pre-flight is the highest-value check here and it costs nothing. Its response confirms
five things at once:

```xml
<Connect action="https://<host>/api/voice/relay-action">
  <ConversationRelay url="wss://<host>/ws"
    welcomeGreeting="Hello! How can I assist you today?"
    conversationConfiguration="conv_configuration_…"
    reportInputDuringAgentSpeech="any"/>
</Connect>
```

1. the auth token and signature validation are good; 2. `wss://` is built correctly from
`TWILIO_VOICE_PUBLIC_DOMAIN`; 3. **our `defaultTwimlOptions` reached the wire** — see below for why
that attribute is the difference between a working agent and a deaf one; 4. CO is wired through the
**noun** (`conversationConfiguration`), which is the path that is not double-billed; 5. `action`
points at a route **we** own.

⚠ **That `action` value changed at T14b, and the reason recorded here was half right.** It read
`https://<host>/conversation-relay-callback` at T13 — TAC's derived default — with the note that
`resolveActionUrl` would "silently redirect it to Studio if `TWILIO_STUDIO_HANDOFF_FLOW_SID` were set,
and our callback route would then never be hit." Studio does win over the derived default, and the flow
SID is now set. But TAC's own route was never a usable handoff target either (it answers `text/plain`
and strips `HandoffData`), so T14b pinned `actionUrl` at `/api/voice/relay-action` in
`buildVoiceTwimlOptions`, which is layer 2 and beats both. **Verified live, not by probe:** a signed
`POST /twiml` after T14b returns our path with no `webhooks.twilio.com` anywhere in the document.

**Still not proven even after two calls:** the 45 s shutdown timeout. Both SIGTERM checks ran with no
WebSocket open, where the 10 s default would also have passed — it only bites if a SIGTERM lands
*during* a call. And nothing has yet exercised a `/ws` signature rejection, which is invisible by
construction (see below).

### The three things in `voice.ts` that are not optional

1. **`sendStreamingResponse` is passed `{ signal }`.** TAC resolves
   `options?.signal ?? activeTask?.controller.signal`, and `cancelStreamTask` aborts the controller
   **and then deletes the map entry** — so on a barge-in the fallback is `undefined`,
   `signal?.aborted` is falsy forever, and the caller is talked over with the answer they just
   interrupted. `tests/voice.test.ts` asserts it is *our* signal; removing the option fails that test
   with `expected [ undefined ]`, which is exactly the production symptom. **Proven to bite.**
2. **`reportInputDuringAgentSpeech: 'any'`** in `buildVoiceTwimlOptions(publicDomain)` — a **function**
   since T14b, not the `VOICE_TWIML_OPTIONS` const this file used to name, because the second key
   (`actionUrl`) depends on the public host. The reasoning below is unchanged. The ConversationRelay default
   changed from `any` to `none` in May 2025. With `none` a barge-in still stops the audio and still
   fires `interrupt`, but the words that caused it are **never delivered as a `prompt`** — the agent
   stops talking and then cannot hear. Every example written before May 2025 omits this attribute.
3. **An empty answer speaks the fallback.** `sendStreamingResponse` emits the `{token:'', last:true}`
   end-of-turn marker *only if at least one token was sent*, so a zero-token turn closes nothing and
   the caller holds an open line forever. Also proven to bite.

Voice's abort branch is the **opposite** of `messaging.ts`'s and the difference is deliberate: on SMS
`aborted` can only be our own timeout, so it speaks a fallback and publishes `error`; on voice it means
the caller interrupted on purpose, so it says nothing and reports nothing. TAC has already sent the
finalization if any token went out, and sending another creates the spurious empty turn its own source
warns about.

### Ending the call — `end_call`, and why it is a two-step mechanism

The first live call exposed the one real gap: the agent had no way to hang up, so a finished
conversation sat there with the line open until the caller gave up. Fixed with a tool plus one
protocol frame, and the split between them is the whole design.

**`end_call` does not end the call — it records an intent.** Tools run INSIDE the model loop, before
the turn's final text is generated, let alone streamed and spoken. A tool that hung up where it stands
would cut the caller off before the goodbye, often before the model had written it. So
`server/agent/tools/end-call.ts` stores "this conversation asked to end" and returns a message
addressed to the model (*"say one short goodbye and nothing else"*), and `voice.ts` sends the frame
**after** `sendStreamingResponse` resolves.

**The frame is `{"type":"end"}`, written to the socket ourselves.** Twilio documents it as *"End the
session and return control of the call to Twilio"*, with `handoffData` **optional**. TAC has no
end-session method: it builds this same frame for Studio handoff and parks it on
`session.pendingHandoffData`, which is drained **only inside `sendResponse` and never inside
`sendStreamingResponse`** — so on a streaming channel a parked frame would never be sent at all. That
is a live trap for T14b's handoff work, **and T14b both fell into it and out the other side**: it is
now `voice.ts` that performs the five-line drain, and *because* `sendResponse` drains the same field
itself, the empty-answer fallback briefly sent two frames on one socket. See T14b below.
`getWebsocket()` is public, so writing the documented frame needs no vendor internals.

Measured on the call that proved it, and both correct a guess made before it:

- **ConversationRelay DOES drain queued audio before closing.** `voice.end` at 18:14:49.448,
  `voice.disconnect` at 18:14:51.194 — a **1.75 s** gap in which "Goodbye." was spoken. The docs do
  not promise this (`tokens-played` is named in the attribute table and appears nowhere in the
  websocket-messages reference, and TAC drops unrecognised inbound frames anyway), so it was the one
  thing only a call could settle. It is now settled empirically, not by inference.
- **No Twilio alert is raised, contrary to what was predicted here.** The worry was that TAC answers
  the `<Connect action>` route with `"OK"` as text/plain rather than TwiML, so Twilio would get
  nothing actionable and log a warning. Checked `monitor.twilio.com/v1/Alerts` right after the call:
  **zero alerts on the account.** The session ends, control returns, the call completes clean. So
  returning real `<Hangup/>` TwiML from that route is NOT needed — do not "fix" what is not broken.

**Interrupting the goodbye cancels the hangup.** Talking over "goodbye" is how a caller says *"wait,
one more thing"*, so the abort branch calls `forgetEndCallRequest` rather than honouring the pending
end. `tests/voice.test.ts` asserts both that no frame is sent AND that the intent does not survive
into the next turn — the second half matters more, because a leaked intent hangs up on someone
mid-conversation one turn later.

`end_call` sets `requires: 'voice'` and is deliberately NOT in `DEMO_TOOLS`, whose contract is that
every member works with zero credentials — hence the new `SHIPPED_TOOLS`. It costs a step: the model
calls the tool and then speaks, so a closing turn uses two of the voice prompt's three.

**The prompt is what decides WHEN**, and it is Langfuse-versioned, so that judgement is tunable
without a redeploy. `demo-agent-voice` was re-seeded to **v3** carrying `end_call` and the
when-to-end guidance. `scripts/seed-prompts.ts` now takes an optional name —
`pnpm seed:prompts demo-agent-voice` — because every run creates a new version and moves
`production`, so seeding everything to ship one prompt silently relabels the others and can demote an
operator's UI edit. `demo-agent-text` was deliberately left at its v2 edit.

### Deviations from the plan, both deliberate

- **`memoryMode: 'never'` for voice, not `'once'`.** `composeMemory` is still `passthroughMemory`, so
  a Recall response is fetched and discarded — `'once'` would put a Conversation Orchestrator
  round-trip in front of the first spoken word for no effect. T14 should revisit `'once'` when it
  wires a real compose port.
- **Barge-in history keeps the generated partial, and that overstates what the caller heard.** Ratified
  known limit. `streamedText` is everything we *sent*; the ground truth is `utteranceUntilInterrupt`,
  which arrives on the `interrupt` callback *after* `history.append` has run. It is published on
  `voice.interrupt` for the console, and deliberately not written back. Consequence to say out loud:
  the model's history can claim it said a tail the caller never heard, and may refer back to it.

### Account changes made for voice — reversible, and record them

> **Account-specific values were scrubbed from this section at T15.** They were a phone number written
> twice, two trunk SIDs and two `PN` SIDs, spelled out in full. A committed doc is the wrong place for
> them: they are account identifiers, and they go stale silently. What follows is the *shape* of the
> problem plus how to rediscover the values in about thirty seconds. Read the live account, not this
> file. (Nothing enforces this — there is no test for it.)

`TWILIO_PHONE_NUMBER` could not receive voice at all: it was the **only** number on a SIP trunk, that
trunk had **zero origination URLs**, and **a trunked number ignores its own `voice_url`**. That is the
entire failure, and it presents as "Twilio never calls my webhook" while the webhook is perfectly
correct. So:

| | Before | After |
|---|---|---|
| `trunk_sid` | the trunk's `TK…` SID | `null` (the trunk now holds no numbers) |
| `voice_url` | `null` | `https://$TWILIO_VOICE_PUBLIC_DOMAIN/twiml`, POST |
| `sms_url` | `""` | `""` — untouched; SMS still arrives via the CO `statusCallbacks` |

**How to rediscover all of it.** `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET` come
from the shell profile, not `.env` — see the T15 section:

```bash
# the number's SID, its trunk, and both webhook URLs
twil api core incoming-phone-numbers list --properties phoneNumber,sid,trunkSid,voiceUrl,smsUrl
# trunks, and what is ACTUALLY attached to one
twil api voice trunks list
curl -s -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  "https://trunking.twilio.com/v1/Trunks/<TK…>/PhoneNumbers"
```

⚠ **There are TWO numbers on this account, and confusing them wastes an afternoon.** One is
`TWILIO_PHONE_NUMBER`, the demo's; the other is unused *by the app*. The command above tells them
apart — the demo's is the one whose `voiceUrl` points at `TWILIO_VOICE_PUBLIC_DOMAIN`. T15 found a use
for the spare one and a trap that comes with it: see **"Testing SMS from a number on the same account
doubles every reply"** below.

A trap found the hard way: **`DELETE /Trunks/{TK}/PhoneNumbers/{PN}` returns 204 for a number that was
never on the trunk**, so a 204 is *not* evidence that anything was detached. Verify with
`GET /Trunks/{TK}/PhoneNumbers` afterwards.

~~`TWILIO_VOICE_PUBLIC_DOMAIN` is the ngrok host, so two things must be repointed when the tunnel
restarts.~~ **Superseded at T15: ngrok is retired.** The host is now the stable
`$APP_NAME.twilio.dtolb.com`, and `scripts/repoint-public-host.ts` moves all three places at once.

### T13 prerequisites discovered while doing T12

> **READ THIS FIRST: where TAC's source is.** `node_modules/twilio-agent-connect` is **dist-only** —
> `dist/index.js`, `dist/index.d.ts`, `dist/index.js.map`, **zero `.ts` files, no `packages/`**. So the
> `packages/server/src/lib/server.ts:242-259` style citations in the plan and in this file do **not**
> resolve there. They resolve in a **sibling checkout**:
> `/Users/dtolbert/code/demo-building-tools/twilio-agent-connect-typescript`, clean at tag **`v2.2.0`
> (`a7a58f2`)**, matching the installed version. Two path traps inside it: **`voice.ts` lives at
> `packages/core/src/channels/voice.ts`** (1745 lines), *not* under `packages/server/`; and **TAC ships
> **31 test files** — ⚠ CORRECTED AT T14; this line previously said TAC ships none, and the plan's
> footgun #35 said the same. Only `node_modules/twilio-agent-connect` is test-free, because it is
> dist-only. The SIBLING CHECKOUT at v2.2.0 ships 31 test files, four of which cover the built-in
> tools (`tests/handoff.test.ts`, `tests/tools.test.ts`, and two memory suites), plus
> `tests/voice-channel.test.ts` and `tests/voice-channel-active-memory.test.ts`. **They are usable as
> evidence**, and T14 used them: the five-layer `actionUrl` precedence and the fact that `session`
> reaches the prompt callback under every `memoryMode` are both test-backed there, not inferred.
>
> For "what is actually executing", read **`dist/index.js`** — bundled but **not minified** (7021
> lines, JSDoc intact), and it greps well. Class landmarks (2.2.0): `TACConfig` 1350, `TAC` 2698,
> `BaseChannel` 3172, `MessagingChannel` 3528, `SMSChannel` 4170, `VoiceChannel` 4689,
> `MemoryPromptBuilder` 6062, `TACTool` 6180, `TACServer` 6584. Line numbers below are bundle
> coordinates unless a `packages/…` path is given.

- **Register `fastify-graceful-shutdown` ourselves, with a larger `timeout`, before `start()`.**
  Now confirmed line by line rather than predicted, and every number checks out:

  | Fact | Evidence |
  |---|---|
  | TAC registers it with **no options** | `dist/index.js:6918` — `if (!this.fastify.hasDecorator("gracefulShutdown")) await this.fastify.register(gracefulShutdown)` |
  | The option is named exactly **`timeout`**, default **10000** | `fastify-graceful-shutdown@5.0.0/index.js` — `const timeout = opts.timeout \|\| 10000` |
  | The watchdog is unconditional | `terminateAfterTimeout()` → `setTimeout(() => handlerEventListener.exit(1), timeout).unref()` |
  | TAC waits up to **30 s** for WebSockets | `dist/index.js:6970` — `async waitForWebSocketsToClose(timeoutMs = 3e4)` |
  | Our registration wins | the guard is `hasDecorator("gracefulShutdown")`, and the plugin sets it via `fastify.decorate('gracefulShutdown', addHandler)` |

  **The ordering is the whole problem.** The plugin's own `shutdown()` does
  `await Promise.all(handlers.map(h => h(signal)))` and only **then** `await fastify.close()`. TAC's
  handler is `waitForWebSocketsToClose()` + `tac.shutdown()`. Our `preClose` hook — the only telemetry
  flush — runs *inside* `fastify.close()`, i.e. **behind** a wait that can last 30 s, while the
  watchdog fires at 10 s and `exit(1)`s. So with one open WebSocket at SIGTERM: no `fastify.close()`,
  no `preClose`, no flush, and the last turn of the call is missing from Langfuse with no error. Pick a
  `timeout` above 30 s **plus** flush headroom. SMS opens no WebSockets, which is why T12 never saw it.

  Two things not to do alongside it: don't add `process.on('SIGTERM')` in the TAC path (the plugin
  registers `once` listeners on SIGINT/SIGTERM itself and *warns* `handler was already registered` if
  it finds any), and don't register the plugin twice — the second `fastify.decorate` of the same name
  throws.

- **Voice `captureRules` must stay EMPTY** in the CO configuration — re-adding them double-bills STT
  under ConversationRelay. Verified still empty on 2026-09-11: `channelSettings.VOICE.captureRules` is
  `[]` and `statusTimeouts` is `null`. Leave both alone.
- **Do NOT `registerChannel(voiceChannel)`** (plan footgun #2, still true), and voice needs
  `TWILIO_VOICE_PUBLIC_DOMAIN`, which SMS did not. TAC builds `wss://${voicePublicDomain}${wsPath}`
  (`dist/index.js:4811`) and throws *"needs a WebSocket URL"* without it.
- **`onMessageReady` is global across channels** (already noted above) — branch on `channel` there
  rather than registering a second handler.

## T14, Conversation Memory + built-in tools — built, proven, and eleven corrections

New: `server/twilio/{memory-compose,builtin-tools}.ts`, `shared/tac-tool-names.ts`,
`scripts/{verify-memory,verify-knowledge,seed-knowledge,knowledge-articles,repoint-public-host}.ts`,
`tests/{memory-compose,builtin-tools}.test.ts`. Changed: `server/twilio/{tac,voice}.ts`,
`server/agent/{run-turn,types}.ts`, `server/agent/tools/{registry,resolve}.ts`,
`server/agent/prompt/defaults.ts`.

Design and plan: `docs/superpowers/specs/2026-09-11-t14-memory-and-builtin-tools-design.md` and
`docs/superpowers/plans/2026-09-11-t14-memory-and-builtin-tools-plan.md`. **Both are now wrong in the
places listed below** — this section wins.

### The one thing to understand about Conversation Memory

**Extraction is POST-conversation only. There is no mid-conversation extraction.** Recall works on
every turn, but nothing is in the store until a PRIOR conversation has closed and been processed. So:

- Memory makes the **next** conversation smart, not the current one. "It remembered what I said a
  minute ago" is `server/agent/history.ts`. Memory is "it remembered me from last week."
- **Any honest test needs two conversations with a close between them.** One conversation cannot
  demonstrate memory no matter how long it runs.
- Measured: **~2 seconds** from CLOSED to the observation appearing. The slow part is the *close*
  (5m36s, `statusTimeouts.closed: 5`, timed from CREATION), not extraction.

### What is wired, per channel

| | `memoryMode` | tools offered |
|---|---|---|
| SMS / bench prompt (`demo-agent-text` v3) | `'always'` — Recall per message, utterance used as a semantic query so observations come back RANKED | `lookup_order`, `get_store_hours`, `search_knowledge`, `retrieve_profile_memory` |
| voice (`demo-agent-voice` v5) | `'once'` — one Recall per conversation, cached on the session by TAC | `lookup_order`, `get_store_hours`, `search_knowledge`, `end_call` |

`retrieve_profile_memory` is deliberately **not** on voice: memory already arrives in the system prompt
every turn, so there it could only re-fetch what the model can already read, at the price of a step —
and a step on voice is silence.

### THE FLAG WAS ENOUGH — the biggest open risk, closed

`memoryExtractionEnabled: true` on the CO configuration is **sufficient**. `intelligenceConfigurationIds`
can stay `[]`.

This was the plan's single largest risk, because the one configuration on this account with real
observations (`Flight-sandbox-conversations`) has extraction on **and** a populated
`intelligenceConfigurationIds`, and every one of its observations carries an
`intelligence_operatorresult_*` source — which reads as causal. It is not. Our observation also carries
an `intelligence_operatorresult_*` source with an EMPTY array on the configuration: extraction uses an
operator internally without you attaching one. Do not attach one, and above all **do not add voice
capture rules** (see below) while chasing this.

Also confirmed harmless: `SMS.statusTimeouts.inactive` is `null`. Only the CLOSED transition triggers
extraction here, and CLOSED alone is enough.

### The bug T14 nearly shipped — read this before trusting a green check

With the wiring complete, **every instrument reported success**: `pnpm typecheck` 0, 286 tests green,
the boot log listing a 5-tool catalog, `/health` reporting `knowledge: true`, and `verify-tools.ts`
printing *"all checks passed"*. **Both new tools were dead.**

A tool being in the catalog is not a tool being offered. **A PROMPT has to name it**, and neither
compiled default did. Nothing in the repo could notice, because every check verified the catalog rather
than the offer. The question that found it was *"what does the live prompt actually name?"*

Two consequences worth keeping:

- `verify-tools.ts` reports `catalog (3 tools)` and structurally CANNOT see the built-ins — it imports
  the module-level `toolCatalog`, while the augmented catalog exists only inside `bootTac`. That is
  correct behaviour and a permanent blind spot of that script.
- `resolve()` now classifies a TAC-provided name absent from the catalog as **`unavailable`, not
  `unknown`**. `demo-agent-text` serves both SMS and the bench, so `unknown` would have warned once per
  bench turn about tools that are neither typos nor removed. `shared/tac-tool-names.ts` is the one
  source of truth both sides import, because `builtin-tools.ts` imports TAC and `server/agent/` may not.

### Eleven corrections to the design, the plan, and this file

Each was found by executing something, not by rereading it.

1. **TAC ships 31 test files.** See the corrected block above. Both this file and plan footgun #35 said
   none.
2. **TAC never composes a prompt** — see the rewritten correction #9 above. This undercut the stated
   reason for `memoryMode: 'never'` for two tasks.
3. **`communicationsLimit` is already `0`** (`config.ts:19`, `.default(0)`, asserted in TAC's own
   `tests/config.test.ts:485`) and is **not a channel option** — `BaseChannelOptions` has exactly
   `memoryMode` and `dedupCapacity`. `./tac.ts` omits `memoryConfig`, so the running app always had 0.
   ⚠ TAC's own JSDoc at `types/memory.ts:169-170` claims the default is 10. It is stale.
4. **`session` is on the voice prompt payload in EVERY memory mode.** The spread is
   `...session !== undefined && { session }` — gated on its own existence, not on `memoryMode`. It had
   been reachable since T13 and was simply discarded, `profileId` with it.
5. **Memory is an APPENDED system part, not a slot** (`run-turn.ts:110`). `slots.ts` and the compiled
   prompt text needed no change. Adding a `{{memory}}` placeholder would ship a visible
   `[[UNKNOWN SLOT: memory]]` into a live prompt.
6. **ONE augmented `TurnDeps`, not one per channel.** The design argued per-channel was forced by
   voice's `profileId`; but `profileId` rides `TurnInput` (per-turn) while `TurnDeps` is per-process.
7. **`memoryChars` did not need building** — `memory.recall`'s timed step already reports `chars`.
8. **`createKnowledgeSearchTool` is SYNCHRONOUS and makes no network call.** Only the `…Async` variant
   does. Lazy construction is still right, but for the other two reasons.
9. **`tac.fetchProfile` already never throws** (catches, returns `undefined`), while
   **`new TACMemoryResponse(data)` CAN throw from its constructor** — it parses each communication.
   With `communications: []` there is nothing to parse.
10. **`TWILIO_MEMORY_PROFILE_TRAIT_GROUPS` does not exist in this repo.** It is a TAC `fromEnv()`
    variable and we deliberately never call `fromEnv()`. So the design's "two filters must agree"
    warning is moot: neither is set. Also `buildProfilePrompt` is not exported, so
    `MemoryPromptBuilder.build` is the only route to `## Customer Profile`.
11. **The Knowledge control plane is `knowledge.twilio.com/v2/ControlPlane/KnowledgeBases`**, not
    `conversations.twilio.com` (that host owns CO configurations). A knowledge-base create returns
    202 + `statusUrl`; a SOURCE create returns 201 with `status: QUEUED` and is not searchable until
    COMPLETED. Five further doc contradictions are recorded in `scripts/seed-knowledge.ts`.

### `search_knowledge`: its description is load-bearing, because score cannot gate

**`score` from the Search API is not comparable across queries** — the top hit is normalised per query.
Measured against the real base:

```
in scope   "What is your return window?"              1.0   / 0.54  / 0.53
OUT        "What time does the Downtown store close?" 0.8   / 0.736 / 0.732
OUT        "Where is my order A4721?"                 0.816 / 0.468 / 0.38
```

An out-of-scope order query scores **0.816 — higher than the in-scope query's own second hit**. So no
threshold can distinguish "the library covers this" from "it does not". The only two mechanisms keeping
`search_knowledge` out of `lookup_order`'s and `get_store_hours`'s territory are **content curation**
(the five articles deliberately exclude order status and store hours) and **the tool's description**,
which is ours to write because TAC's factory takes `name` and `description` as required arguments.
Do not treat that prose as decorative.

### Two traps that cost real time today

- **`lsof -ti :8910` MATCHES NGROK, and killing it takes the tunnel down.** That list includes
  processes holding a *connection* to the port, not just the listener — and ngrok, while forwarding,
  is one. Three "the tunnel keeps dropping" incidents were self-inflicted. Use
  **`lsof -ti :8910 -sTCP:LISTEN`** — verified: with the filter, a restart leaves the tunnel up.
- **`twil webhook invoke` against `localhost` returns a FALSE 403.** It signs
  `http://localhost:8910/…` while TAC rebuilds the URL defaulting to **https** when
  `X-Forwarded-Proto` is absent, and `twil` has no header flag. Sign the `https://` form and POST to
  `http://` — there is a worked example in the T14 session. Through a real tunnel it is fine, because
  ngrok sets the header.
- **Do NOT test inbound SMS from a second number on the same account.** The message is captured twice
  (once as outbound from the sender, once as inbound to the agent) — both match
  `{from:'*', to:NUMBER}` — so two turns run and the sender gets two different replies. Not a
  production bug; a real customer's handset is not on the account.

### The voice call, and the bug only a call could find

Four turns, `search_knowledge` twice, `end_call` fired, `/conversation-relay-callback → 200`.

**The profile fetch was uncached and ran on every turn**: `profileMs` 76 / 623 / 113 / 134 ms across
four turns of one call, each in front of the first spoken word. Voice runs `'once'` precisely so a
round-trip does not sit there per turn, and an uncached `fetchProfile` bolted on top partly undid it.
Now cached per conversation, **negative results included** — a profile that times out would otherwise
pay full latency on every remaining turn. Bounded at 200, no lifecycle hook (conversation ids are
unique, so a stale entry can never be re-read).

**Memory is not what makes voice TTFT slow.** Measured `first token in 2666ms (2587ms of it inside the
model call)` — our whole preamble is **~79ms**. Every turn made a tool call (2 steps); T13's fast
463–509ms turns were single-step, no-tool turns. The cost is the tool round-trip.

**Both of those are now VERIFIED on a later call, and the way they were verified is the lesson.**

The verbosity problem was real: the first call's opening turn ran to **455 characters** against a prompt
asking for one or two sentences, and the caller barged in at 459 ms and 346 ms — cutting it off.
`demo-agent-voice` v5 adds *"say only the part that answers what they asked, then offer the rest"*.
Measured after: **310 / 231 / 265 / 247 / 214 characters**, and the barge-ins moved out to
462 / 782 / 1601 / 1121 ms. Better rather than perfect — still above "one or two sentences", and worth
another pass if a demo audience notices, but no longer the thing that gets you interrupted.

The profile cache is verified too — same conversation, `profileMs` **82 then 0**.

⚠ **AND THE FIRST ATTEMPT TO VERIFY IT WAS A FALSE NEGATIVE, for a reason worth internalising.** The
call showed `profileMs` of 75/142/108/127/139 — non-zero on every turn, i.e. the cache apparently doing
nothing — while its unit tests passed. The code was fine: **the agent process had been started 53
minutes BEFORE the fix was committed**, and Node does not hot-reload. The prompt fix landed on that same
call because a Langfuse prompt is fetched at run time behind a ~20 s TTL; the code fix could not, because
it is compiled into a process.

That is Layer 0 of the dev loop demonstrating its own value by accident: **a prompt change needs no
restart, a code change always does.** When a fix "does not work" on a live channel, check the process
start time against the commit time before debugging the logic — `ps -p <pid> -o lstart=`.

The cheap way to verify a per-conversation cache without spending a call: send ONE SMS from another
number on the account. The double-capture trap (above) produces two turns in the SAME conversation, so
the second is a guaranteed cache hit.

## T14b, DONE — Studio handoff + browser softphone, proven on a real call

Split out of T14 at the `web/` boundary. **Done, and verified end to end on one real phone call on
2026-09-15**: four turns, then the caller asked for a person, and a person answered — in a browser, with
the transcript already on screen.

New: `shared/handoff.ts`, `server/handoff/snapshots.ts`, `server/twilio/{handoff,voice-token}.ts`,
`server/http/{routes-voice-action,routes-handoff}.ts`, `web/src/app/softphone/{page,softphone-client}.tsx`,
`scripts/{studio-handoff-flow,seed-studio-flow}.ts`, `tests/{handoff,voice-action,handoff-http}.test.ts`,
`tests/helpers/fake-tac.ts`. Changed: `server/twilio/{voice,tac,builtin-tools}.ts`,
`server/http/app.ts`, `server/index.ts`, `server/agent/prompt/defaults.ts`, `shared/tac-tool-names.ts`.
New dependencies: `@fastify/formbody`, `twilio@5.13.1` (pinned **exactly**, to dedupe with TAC's
resolved copy rather than install a second SDK), and `@twilio/voice-sdk@2.18.4` in `web/` only.

Design and plan: `docs/superpowers/specs/2026-09-14-t14b-studio-handoff-and-softphone-design.md` and
`docs/superpowers/plans/2026-09-14-t14b-studio-handoff-and-softphone-plan.md`. **Both are wrong in the
places listed below** — this section wins.

### What was built

- **`server/twilio/handoff.ts`** — the `handoff` `ToolDef`, wrapping TAC's `createStudioHandoffTool`.
  It **does not transfer the call**: like `end_call`, it records an intent, because a tool runs inside
  the model loop before the turn's text exists. What it delegates for is the part a hand-built frame
  would silently skip — TAC parks a *complete* `{type:'end',handoffData:"<json>"}` frame on
  `session.pendingHandoffData` and performs the two Conversation Orchestrator side effects
  (`updateConversation(…,'INACTIVE')`, then `clearStatusCallbacks(…)`). Construction is lazy, inside
  `execute`, because TAC's factory has three guards that **throw at construction** — at boot that is a
  crash, inside `execute` it is a structured miss the model can speak about. `requires: 'handoff'`, and
  it is the first tool to claim that pre-existing capability. Its description is ours and is
  load-bearing for the same reason `search_knowledge`'s is: TAC's default invites a transfer whenever
  the model feels stuck, which on a demo means transferring instead of searching the policy library.
- **`server/twilio/voice.ts`** — the drain, and the `actionUrl` pin. `VOICE_TWIML_OPTIONS` became
  **`buildVoiceTwimlOptions(publicDomain)`** because the second key depends on the public host. After
  the farewell has streamed, the handler consumes the intent, snapshots the transcript, sends the
  parked frame, and `delete`s the field exactly as TAC's own drain does. **Handoff beats a pending
  `end_call` unconditionally** — two `{type:'end'}` frames on one socket is undefined behaviour, and
  hanging up on someone who has just asked for a human is the worst available outcome. A barge-in
  during "putting you through" cancels the transfer, same argument as the goodbye.
- **`server/http/routes-voice-action.ts`** — `POST /api/voice/relay-action`, the `<Connect action>` URL
  and the one place a call is routed. It returns **valid TwiML on every path, including the buggy ones**:
  unparseable `HandoffData` answers `<Hangup/>` with a loud log rather than a 500, and a missing account
  SID falls back to dialling the browser client rather than emitting a URL Twilio would 404. No Twilio
  signature validation, stated rather than hidden — `validateRequest` lives in the `twilio` package,
  which the architecture test confines to `server/twilio/`; an unauthenticated POST here returns routing
  TwiML and nothing else. `@fastify/formbody` is registered by us, **awaited**, inside `bootTac`, because
  TAC's own registration is guarded by `hasContentTypeParser` and a second one throws
  `FST_ERR_CTP_ALREADY_PRESENT`.
- **`server/twilio/voice-token.ts` + `server/http/routes-handoff.ts`** — the minter and the two
  endpoints (`POST /api/voice/token`, `GET /api/handoff/context`). The split is forced: `twilio` may only
  be imported from `server/twilio/`, so minting lives there and is **injected** into the HTTP module from
  `server/index.ts`'s TAC-boot success path. A credential-free process therefore never loads `twilio` at
  all — the same property `bootTac`'s dynamic import already buys.
- **`server/handoff/snapshots.ts`** — the bounded screen-pop store, importing nothing but `shared/`.
  Also forced: `voice.ts` writes it and `server/http/` reads it, so a vendor import here would drag TAC
  into the HTTP layer at module load.
- **`web/src/app/softphone/`** — one client island that dynamically imports `@twilio/voice-sdk`,
  registers as the identity in `shared/handoff.ts`, rings, screen-pops and answers.
- **`scripts/studio-handoff-flow.ts` + `scripts/seed-studio-flow.ts`** — the flow as a **committed
  definition**, and a seeder (`pnpm seed:studio`) that backs the live revision up to disk, publishes,
  then re-reads the published flow and dies unless it dials the identity from `shared/handoff.ts`.

### Seven corrections to the design, each found by reading the code it describes

1. **C1 — the token route cannot live in `server/http/`.** The spec put `AccessToken` + `VoiceGrant`
   there; `tests/architecture.test.ts` allows the `twilio` package only under `server/twilio/` or
   `scripts/`, so that file would have failed the build. Hence the mint-here-inject-there split.
2. **C2 — snapshot at DRAIN time, not inside the tool.** `run-turn.ts` appends the user+assistant pair
   **at the end of `runTurn`, before `done` resolves**, so at tool-execution time history contains
   neither the caller's "I want a human" line — the single most important line on the screen pop — nor
   the farewell. The snapshot is still taken before the socket closes, because the socket closes
   *because* we send the frame.
3. **C3 — the snapshot store must be TAC-free.** Read from `server/handoff/snapshots.ts`'s intended
   callers: putting the store beside the tool would have made `server/http/` load the vendor.
4. **C4 — `handleVoiceDisconnect` must NOT clear the snapshot, only the intent.** The spec said to clear
   both "for the same reason it already clears the `end_call` intent". Wrong for the snapshot:
   `webSocketDisconnected` fires seconds **before** a human presses answer, so clearing there would make
   the screen pop reliably empty on the one path it exists for. Lifetime is bounded by eviction instead.
5. **C5 — `handoff` is named in the VOICE prompt only.** TAC's tool does branch internally and its
   digital branch works, but it sets the conversation `INACTIVE` and clears its status callbacks
   **before** the POST that can fail, and TAC contains no `'ACTIVE'` write and no inverse for
   `clearStatusCallbacks`. On SMS that leaves a customer whose next text reaches nothing, with no
   downstream repair. Sending the frame is what mitigates that failure path on voice; nothing mitigates
   it on SMS. Reversing this is a one-line prompt change.
6. **C6 — `buildHandoffPayload` does not throw on a null profile.** `dist/index.js:6410` is
   `profileId: session.profileId ?? ""`, so an unrecognised caller yields an empty-string `profileId`
   rather than an exception. No profile guard was needed and handoff works for a first-time caller.
   Recorded because it changes an error path we would otherwise have written.
7. **C7 — the Studio flow never receives `HandoffData`, so the `json_object` widget the spec called
   "the load-bearing detail" would have resolved to nothing.** That detail is correct *when Studio
   itself is the `<Connect action>` URL* — ConversationRelay POSTs `HandoffData` in the body and Studio
   surfaces it on the trigger. But §2.1 requires us to own the action route, so Studio is reached by a
   **`<Redirect>`, which starts a fresh incoming-call execution**, and the Incoming Call trigger exposes
   a **fixed** variable list (the Call-resource fields: `From`, `To`, `CallSid`, `CallStatus`, geo).
   Arbitrary query parameters are not among them; passing custom data in is documented for the REST API
   trigger (`{{flow.data.X}}`) and for returning to a TwiML Redirect widget (`{{widgets.NAME.VAR}}`),
   neither of which is a redirect into a fresh voice trigger. So `{{trigger.call.HandoffData}}` would
   have silently resolved to nothing. **The flow therefore needs no handoff data at all** and reduces to
   `Trigger(incomingCall) → connect-call-to client:<identity>`; the reason and transcript reach the
   browser through `GET /api/handoff/context`, correlated on the caller's number — which is the
   mechanism the design already needed anyway, because `connect-call-to` cannot pass parameters to a
   client. Our action route has the parsed `HandoffData` in the POST body; it is what decides to route
   at all.

### The design's six corrections to THIS FILE, and its two hazards

Folded in here because this file is the entry point and the spec is not.

1. **The "coexist" claim at line ~205 is refuted** — see the ⚠ block up there. `/conversation-relay-callback`
   is TAC's own route, answers `text/plain "OK"` and never TwiML, and its payload schema has no
   `HandoffData` field so it **strips** it. Coexistence required a new path we own. Also
   `VOICE_TWIML_OPTIONS` is now a function, `buildVoiceTwimlOptions`.
2. **The five-layer precedence is real and runtime-proven**, not merely read: `onInboundCallTwiml` →
   **`defaultTwimlOptions`** → host per-call → **Studio** → derived default. `actionUrl` is resolved once
   up front, before the three `overlayFields` calls, and `overlayFields` explicitly skips it. Layers 1
   and 3 are unreachable here (never registered; `TACServer` calls `handleIncomingCall(twimlRequest)`
   with no options, so `host` is always undefined inbound), so **nothing sits between
   `defaultTwimlOptions` and Studio**. Driven both ways against the installed `VoiceChannel`: with the
   pin, our path; without it, Studio's `webhooks.twilio.com/…/Flows/…?Trigger=incomingCall`.
   ⚠ And `actionUrl: ''` **silently deletes the attribute and does not throw** — `TwiMLOptionsSchema`
   declares `z.string().min(1)` but `VoiceChannelConfig` is a plain interface, so that validation never
   runs for `defaultTwimlOptions`; `as const` is no barrier either. Hence the boot-time assertion.
3. **ONE handoff tool, not two.** This file recorded "two tools, because SMS completes synchronously
   and voice must park" as a decision; it is a description of TAC's *existing* behaviour —
   `if (session.channel === 'voice')` inside TAC's own tool. The voice branch cannot fail (it builds the
   frame and assigns it); the digital branch POSTs the Studio Executions URL and can return
   `handoff_failed`. The two wire shapes are **not** interchangeable: voice uses lowercase `handoffData`
   as a JSON *string*, digital capital-`HandoffData` as a nested *object* inside `Parameters`.
4. **"Write the frame ourselves" was the wrong instinct.** `session.pendingHandoffData` is a
   **complete frame**, not raw data. The double encoding is the documented contract, not a defect.
   What TAC omits is only the drain: its five lines live inside `sendResponse` (`dist/index.js:5245-5254`)
   and `sendStreamingResponse` has **zero** references to the field.
5. **Landmine 3 is narrower than this file recorded.** TAC's own source says
   *"Downstream (Studio/Flex) flips it back to ACTIVE on pickup and CLOSED on hangup"* — so on the
   **success** path the status is reverted, just not by TAC. The unreverted-broken-conversation outcome
   is specific to the **failure** path, which is exactly the silently-unsent-frame case this task
   eliminates. Sending the frame is not merely the feature; it is the mitigation. The `statusCallbacks`
   half has no downstream repair, and that is the open measurement at the end of this section.
6. **No TwiML Application is required, and `twilio` was not installed.** A TwiML App is needed only for
   **outgoing**; inbound to a browser client needs `incomingAllow: true` and nothing else, so the
   softphone needed **zero account mutations**. `twilio` existed only as TAC's unhoisted transitive dep,
   and TAC's dist contains zero `AccessToken` references, so it was declared directly. Token minting
   needs no API permission at all — it is a locally signed JWT and the key carries `signing`.

**Hazard 1, designed around: the client identity must not contain a hyphen.** The Voice JS SDK documents
the token identity as *"may only contain alpha-numeric and underscore characters"*. The one published
flow on the account dialled a hyphenated client, which is outside that set and undocumented either way.
`CLIENT_IDENTITY` in `shared/handoff.ts` is hyphen-free and is read by the token route, the flow
definition and the page. **Answered live at T14b.7:** a hyphen-free identity registers fine.
⚠ The pre-existing flow's hyphen means the softphone **could never have rung** before this change.

**Hazard 2, designed around: the softphone cannot correlate on `CallSid`.** Studio's `connect-call-to`
widget exposes only `caller_id`, `noun`, `timeout`, `to` — it cannot pass parameters to a client — and
dialling a client mints a **new call leg with a new CallSid**, so `call.parameters.CallSid` in the
browser can never match the inbound call. Correlation is therefore the caller's number (which Studio
preserves via `caller_id`) with a most-recent fallback, and the response **states which match it made**
(`exact` | `caller` | `recent` | `none`). Only the direct-`<Dial>` path can be `exact`, via
`<Parameter name="conversationId">` surfaced as `call.customParameters` — which also means **with a flow
SID set the screen pop can only ever be `caller` or `recent`**; unset it to exercise `exact`.

### Two bugs the whole-feature review caught that the test suite could not

Both are patterns, not one-offs.

1. **Two `{type:'end'}` frames on one socket, on a reachable path.** TAC's `sendResponse` drains
   `pendingHandoffData` **itself** (`dist/index.js:5245-5254`), and the empty-answer fallback called
   `sendResponse` *above* the handoff block. So a zero-token transfer — reachable, since `maxSteps` is 3
   and search + answer + handoff exhausts it — had TAC send the parked frame and then us send a second
   bare one, while the obs event reported `hadPayload: false` for a transfer that carried one.
   **Why it was invisible: `recordingSender` in `tests/voice.test.ts` did not emulate the vendor's
   drain.** A test fake that diverges from the vendor hides the bug the feature is built on. The fake now
   drains, and a new test pins exactly-one-frame — proven red against the old ordering.
2. **`GET /api/handoff/context` with no query parameters returned the newest snapshot** — a full
   verbatim call transcript, 200 OK, unauthenticated, on the path Traefik and ngrok route **publicly**.
   It now requires at least one correlator, and the guard turned out to be one character wide as first
   specified: `?from=` is `''`, which is `!= null`. Blank now counts as absent.

**And a trailing slash in `TWILIO_VOICE_PUBLIC_DOMAIN` would have 404'd every transfer.** It would have
produced `https://host//api/voice/relay-action`, silently. `server/config.ts` rejects a *scheme* in that
variable and says nothing about a trailing slash, so `buildVoiceTwimlOptions` now strips it.

### The live call — measured, one call, 2026-09-15

Four turns, then a transfer. From the obs bus:

```
caller   "Thank you. Can I speak to a person?"
model    handoff{ reason: "caller asked to speak to a person" }
handoff  frameSent: true   hadPayload: true   farewell: "I'm putting you through now."
action   route: "studio"   reasonCode: "live-agent-handoff"
         sessionStatus: "ended"   sessionDurationSeconds: "34"
softphone rang, was answered, screen pop rendered
```

`hadPayload: true` is the assertion that matters: **the real parked frame went out**, not the bare
`{type:'end'}` fallback — and the 28-character farewell streamed in full before it, which is the whole
reason the drain sits after `sendStreamingResponse` resolves.

```
handoff tool execution            553 ms   (two Conversation Orchestrator calls plus the park)
per-turn ttft         2472 / 2411 / 801 / 2257 ms
per-turn total        2712 / 2826 / 1156 / 2484 ms
one barge-in handled            281 ms
tool.selection        "5 of 5 tools resolved", every turn
```

`5 of 5` is what proves `handoff` **resolved** rather than landing in `unavailable` — the T14 lesson that
a tool in the catalog is not a tool being offered, checked at the layer where that failure lives.

**One demo observation, not a bug.** The caller also asked *"Can you send me a text message with that
information?"* and the agent could not comply: there is deliberately no `send_message` tool. The three
reasons are in `server/twilio/builtin-tools.ts`'s header — the model already speaks or sends its own
answer, TAC's `sendResponse` throws **synchronously** on a closed socket so a bare `.catch()` misses it,
and the literal string is the unknown-tool fixture in `tests/tools.test.ts`. Worth knowing before a demo
script invites the question.

### Honest limits, carried from the design's §10 and still true

- **Screen-pop correlation is caller-number plus most-recent.** Two simultaneous calls from one number
  would cross. Acceptable for a demo; stated rather than hidden.
- **The transcript is a new PII surface, and it is deliberately unscrubbed.** `obs/pii.ts` scrubs log
  lines and obs payloads; it does not touch this route's body and must not — the human agent needs the
  real words the caller said. The caller's number is masked for display; the transcript is verbatim by
  necessity.
- **One identity allows 10 concurrent registrations**; the 11th evicts the oldest. Two demo tabs are
  fine, eleven are not.
- **The repo's 7-day supply-chain guard is not enforced.** pnpm 11.8 does not read
  `minimum-release-age` from `.npmrc`, and `pnpm-workspace.yaml` has no `minimumReleaseAge`. Reported,
  not policed: `@twilio/voice-sdk` is pinned by hand to a version older than seven days, and `twilio` is
  pinned to an exact 5.x to dedupe with TAC's copy rather than pull the 6.x line as a second install.
- **Twilio ships no blessed template for this.** Its own handoff Studio template routes to Flex, not to
  a browser client.

### The one open question, now MEASURED — extraction survives a handoff

**Does Conversation Memory extraction still fire for a handed-off conversation? YES. Measured
2026-09-15 on the verified call, and the worry was unfounded.**

The worry was reasonable: TAC's handoff calls `clearStatusCallbacks`, which has **no inverse anywhere in
TAC** — no `'ACTIVE'` write, no re-registration. So a handed-off conversation stops calling `/webhook`
permanently, and the fear was that it would therefore never produce the `CONVERSATION_UPDATED`/CLOSED
event extraction runs off, silently costing T14's memory story every transferred call.

What actually happened, read from the Conversations and Memory APIs after the call:

| | |
|---|---|
| conversation `status` | **`CLOSED`** |
| `statusCallbacks` | **`None`** — so `clearStatusCallbacks` did take effect |
| `createdAt` → `updatedAt` | 14:01:16 → 14:01:48 — **32 seconds**, i.e. it closed when the call ended |
| observations attributed to that conversation id | **3**, all written at 14:01:51 |

So extraction ran **~3 seconds after the close**, consistent with the ~2-second latency T14 measured.

**The mechanism, and why the inference was wrong:** `statusCallbacks` are *outbound notifications to
us*. Clearing them stops Orchestrator telling this process about the transition; it does **not** stop
Orchestrator making the transition or running extraction, both of which are server-side. Losing the
webhook and losing the lifecycle are different things, and only the first one happens.

Two things worth carrying forward from the same measurement:

- **The close was 32 seconds, not the ~5 minutes `statusTimeouts.closed: 5` implies.** That timeout is
  timed from creation and is what T14 measured (5m36s) on a conversation nobody transferred. The
  handoff's own `updateConversation(..., 'INACTIVE')` write evidently short-circuits the wait. Useful
  for demos: a transferred conversation's memory is available almost immediately, where an ordinary one
  takes minutes.
- **The three observations are the caller's own utterances**, not the agent's answers — *"Asked what the
  last order number was (A4721)"*, *"Asked what was discussed during the user's last call"*, *"Requested
  that the order and return-policy information be sent via text"*. So a handed-off call feeds the
  profile exactly as a completed one does.

## T15, Dockerfiles + compose + Traefik — built, routed, and what real traffic did and did not prove

Both processes now run as containers behind the Traefik dev box on **one public host, split by path**.
`ngrok is retired.` The public host is `https://$APP_NAME.twilio.dtolb.com` and it survives restarts,
which removes the three-places-to-repoint tax that T13 and T14 paid on every tunnel restart.

New files: `.dockerignore`, `Dockerfile.agent`, `Dockerfile.web`, `docker-compose.yml`,
`scripts/preflight.mjs`. Modified: `web/next.config.ts` (standalone), `package.json`, `.env.example`,
`scripts/status.mjs`, `server/http/app.ts` (two comments that had become wrong),
`tests/architecture.test.ts` (two new assertions).

`APP_NAME=northwind`, matching the Northwind Traders knowledge-base content.

### The plan's own highest-risk item, and it is an ORDERING risk, not a code risk

**Repoint `TWILIO_VOICE_PUBLIC_DOMAIN` BEFORE `docker compose up`, never after.** That one value builds
*both* `wss://<host>/ws` and the `<Connect action>` URL. Get it backwards and everything looks correct
— container healthy, `/health` reporting `voice: ready`, Traefik routing perfectly — while every
inbound call connects to the dead old host and sits in **silence with nothing in the container logs**,
because the WebSocket never arrives. There is no error to find; that is what makes it dangerous.

`scripts/preflight.mjs` now warns (not fails — an ngrok host is a legitimate choice) when
`TWILIO_VOICE_PUBLIC_DOMAIN` disagrees with `$APP_NAME.twilio.dtolb.com`, and `pnpm status` surfaces
the same mismatch. Related: after **any** `.env` change use `docker compose up -d --force-recreate`,
never `restart` — `restart` re-runs the existing container with its **original env block**, so the
stale host survives and you get the silent failure above.

### Four measured facts that changed the design — none of these were inferred

| Fact | Consequence |
|---|---|
| Traefik runs `--entrypoints.web.address=:80` with **no TLS entrypoint**; TLS terminates in a Caddy **not on this machine**. A Host-header curl to `localhost` and the public URL return **byte-identical bodies** (re-verified at T15: matching SHAs). | The box genuinely provides a public HTTPS host. ngrok can go. |
| `X-Forwarded-Proto: https` **arrives correctly**, because `forwardedheaders.trustedips=172.16.0.0/12` covers Caddy's source. And TAC's `getForwardedProto` defaults to `https` when absent. | The proto middleware is defence in depth, **not** the 403-preventer this doc claimed. Corrected in three places. |
| `TAC_SHUTDOWN_TIMEOUT_MS = 45_000` vs Docker's default `stop_grace_period` of **10 s**. | Compose sets `stop_grace_period: 60s`, or SIGKILL lands 35 s before the only telemetry flush — and Docker reports it as a crash. |
| `host.docker.internal:3100` **answers 200** from a container on `edge`; `langfuse-web` is **ENOTFOUND** there (it is on `langfuse_default`). | Compose overrides `LANGFUSE_BASE_URL`. The plan listed "does it *answer*" as unmeasured; it is now measured. |

### Six container traps that are absent from the dockerizing skill

1. **`stop_grace_period` must exceed the app's own shutdown deadline.** Docker's default is 10 s.
2. **Shell-form `CMD` silently defeats every graceful-shutdown design** — `/bin/sh` becomes PID 1 and
   does not forward SIGTERM. Interacts nastily with (1): a longer grace period makes the symptom
   *slower and quieter*, never louder. Both Dockerfiles use exec form, and T15 proved SIGTERM arrives.
3. **Next `output: 'standalone'` has two near-silent traps.** With `outputFileTracingRoot` at the repo
   root and the project in `web/`, the entry is `.next/standalone/**web**/server.js`, not
   `standalone/server.js` (the official docs show the un-nested path). And standalone **does not copy
   `public/` or `.next/static/`** — skip the hand-copy and the HTML renders looking roughly right while
   every JS/CSS chunk 404s and **React never hydrates**, so `/bench` and `/softphone` become dead
   buttons with nothing in the server log. Verified the opposite: every asset on all three pages 200s.
4. **A subdirectory app that imports above itself cannot use that subdirectory as its build context.**
   `web/` imports `../shared/*.ts`, so the web build context is the **repo root** — directly against the
   skill's "build it from its own directory" note. Both `.npmrc` files and both `pnpm-workspace.yaml`
   files must still be copied: pnpm does not walk up for registry config, and an undecided `allowBuilds`
   makes pnpm 11 **fail** the install with `ERR_PNPM_IGNORED_BUILDS`.
5. **An unset compose project name is the DIRECTORY name, and it prefixes every volume.** Two files in
   one directory therefore share a project: observed live, before `APP_NAME` was changed
   `docker compose ps` listed *Langfuse's* six containers as ours. The worse failure is a renamed or
   moved checkout, which points the stack at volumes that do not exist — Langfuse boots empty, headless
   init makes that look like a healthy first run, and what is actually gone is every versioned prompt
   and the whole trace history, with the agent degrading to compiled-in prompts without erroring. **Both
   files now pin a name:** `langfuse` and `${APP_NAME}`. Recovering the data after the rename was
   `docker compose create` to let Compose own the new volumes' labels, then per volume
   `docker run --rm -v old:/from:ro -v new:/to alpine cp -a /from/. /to/` with the stack down.
6. **`environment: FOO: "${FOO:-}"` always sets the key**, to `""` when unset — and `environment:` beats
   `env_file:`. So the substitution form lets a forgotten `export` **shadow a good `.env` value with an
   empty string**. The bare-name list form (`- FOO`) passes a variable through only if set. That is why
   `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET` are listed by bare name: **they live in
   the shell profile on this machine, not in `.env`**, so a container gets none of them otherwise.

Repo-specific and easy to lose: **the compose file must be named `docker-compose.yml`**, not the
`compose.yaml` Compose v2 prefers. `tests/architecture.test.ts` hardcodes the name, and the wrong one
leaves its assertions inert.

### `pnpm up` is a trap — the scripts are `stack:up` / `stack:down`

Nearly shipped as `pnpm up`. **`up` is a built-in alias for `pnpm update`, and a package.json script
cannot shadow a built-in** — so `pnpm up` would have updated every dependency and rewritten the pinned
lockfile (with `minimum-release-age=10080` in play) instead of starting anything. Renamed to
`pnpm stack:up` / `pnpm stack:down`, which also matches the repo's existing colon convention.

### Two test gaps closed, and the vacuous-pass guard removed

`tests/architecture.test.ts` proved the proto middleware was **defined**. A middleware that is defined
but never **referenced** is silently inert, and Traefik neither warns nor errors — so that assertion
passed on a broken config. Now added: the agent router must actually reference it, and
`loadbalancer.server.port` must equal `AGENT_PORT` / `WEB_PORT` from `shared/ports.ts` (deliberately
compile-time constants, so nothing else could catch drift).

The `if (!existsSync(compose)) return` guard is **gone**, replaced by an assertion. It was correct
while the file did not exist; now it could only ever hide a rename.

**All four assertions were verified falsifiable**, not just green — each was deliberately broken and
observed to fail, then restored (the file was diffed byte-identical afterwards): removing the
`middlewares=` reference, drifting the port to 9999, spelling it `customRequestHeaders` (which works
in Traefik and must fail here), and dropping one `PathPrefix`.

### Verified — at the layer where each failure lives

- **Boot logs read, not assumed.** A restart policy turns a boot throw into a crash loop, so a running
  container is not evidence. `docker compose logs agent`. (The stack now runs `restart: "no"` — see the
  reboot-behaviour entry below — which removes the crash-loop masking as a side effect.)

  ⚠ **Corrected after the T15 review, because the first version of this bullet was wrong twice and sat
  under a heading that says "Verified".** It claimed `preflightDefaultPromptTools()` "deliberately
  throws on a bad tool name" — it deliberately does the *opposite*: `server/agent/tools/resolve.ts`
  says outright *"Logs rather than throws: the process still boots"*, and `server/index.ts` calls it
  bare. So the likeliest clone edit — a `DEFAULT_PROMPTS` entry naming an absent tool — is one logged
  ERROR on a container that runs perfectly happily, which is easy to scroll past. The real boot throws
  are a **duplicate or ill-formed name in the catalog**, which fires when `createToolCatalog` runs at
  *import* (`server/agent/tools/catalog.ts` — which is why `index.ts` guards the import, not the call),
  and an avvio-microtask `FST_ERR_DEC_ALREADY_PRESENT`, which is uncatchable. It also said "empty
  logs": a throw prints a stack trace, and `server/logging.ts` runs pino with no worker transport, so
  nothing is buffered away. Empty logs plus **exit 0** is a different failure — a dev-only run guard.
- **The image carries no secrets.** `.env` is absent from `/app`; the CMD's `--env-file-if-exists` is a
  deliberate no-op inside the image.
- **CA at runtime, not just at build.** A build-only secret fixes `pnpm install` and leaves runtime
  `fetch()` broken — and a green build hides it. Probed against `api.elevenlabs.io`, which is genuinely
  intercepted: TLS succeeds. `api.twilio.com` passes *without* the CA and would have given a false
  all-clear.
- **Routing, both ways.** `/health` → agent, `/` `/bench` `/softphone` → Next, all 200 on the
  Host-header curl and through the public edge. `GET /api/bench/turn` returns Fastify's **JSON** 404
  while `/nope` returns Next's **HTML** 404 — that contrast is the proof the split is real and not a
  coincidence. `POST /api/bench/turn` → 200, and `POST /api/voice/token` mints a real AccessToken.
- **SSE held 184.7 s with 15 s heartbeats and no drop.** This Traefik sets no
  `respondingTimeouts.*`, and a total-duration read deadline would be immune to the heartbeat and would
  kill a live call mid-sentence. It ended only because we stopped the agent, and the number was not
  round.
- **`signedUrl` off `/events/stream` is the ground truth, and it is right:**
  `https://northwind.twilio.dtolb.com/twiml` with `hasSignature=true` and 200. That single string proves
  *both* halves — the proto and the `X-Forwarded-Host` half, which **nothing in the Traefik labels
  pins**.
- **A signed webhook pre-flight, free, before spending anything:**
  `twil webhook invoke --type voice --auth-token … https://…/twiml` → 200 + TwiML naming the **new**
  host in both `wss://…/ws` and `action=…/api/voice/relay-action`, with `Via: 1.1 Caddy` confirming it
  came through the real public edge. This is the highest-value pre-call check in the repo: it validates
  the signature path end to end for zero cost.
- **A real SMS round-tripped** through the containerised stack: webhook 200, signature valid, Langfuse
  prompt `demo-agent-text v3` (**not** `fallback`, so the Langfuse override works), memory recall of 6
  observations / 3 summaries, `get_store_hours` executed, reply delivered.

### ⚠ Testing SMS from a number on the same account DOUBLES every reply — and it is not a bug

This cost an hour and would cost the next person the same, so it is worth the space.

Testing with the account's spare number produced **two** agent turns and **two differently-worded
replies** for one inbound text. It looks exactly like a duplicate-delivery bug. It is not:

| day | sender | replies per inbound |
|---|---|---|
| 11 Sep (T12) | external handset | **1.00** ✓ |
| 14 Sep (T14b) | the spare **on-account** number | 2.00 |
| 15 Sep (T15) | the spare **on-account** number | 2.00 |
| 15 Sep (T15, **the control**) | external handset, through the containers | **1.00** ✓ |

That last row is the one that settles it: same containers, same CO configuration, same capture rules,
same minute — only the sender changed, and the doubling vanished.

**Mechanism**, pinned by reading `eventType` off `/events/stream`: CO emits **two
`COMMUNICATION_CREATED` events** ~300 ms apart, and TAC runs a turn for each. An on-account send creates
two communication records — the `outbound-api` leg and the `inbound` leg — and **both carry identical
`from`/`to`**, so the capture rule `{from: "*", to: "$TWILIO_PHONE_NUMBER"}` matches both. An external
handset creates only the inbound leg, which is why 11 Sep is clean.

Consequences worth stating plainly:
- **T14b's "ten SMS turns" figure is inflated**; roughly half were the same message answered twice.
- The doubling is a **test-method artefact**, not a regression in T14b or T15. Do not "fix" it — do not
  touch the capture rules, and in particular do not remove the bidirectional outbound rule, which is
  what lets CO see the agent's own messages in the transcript.
- **Verify SMS from an external handset, always.** The on-account number is still useful for proving the
  *route* (webhook 200, signature valid, a turn runs) — it simply cannot measure reply count.

### CLOSED by real traffic from an external handset, 2026-09-15 17:56–17:58 UTC

Same container process throughout (`restarts=0`, started 15:51 UTC), so this is the containerised run
and not a host fallback.

**The call — `/ws` is no longer an act of faith.** `GET /ws` from `54.174.70.237` (Twilio
ConversationRelay) at 17:56:40, **logged with no matching response line**, which is exactly the
`@fastify/websocket` hijack signature the code documents — the absence *is* the evidence, once you know
a successful upgrade produces it. The call ran **72 s**. Then `POST /api/voice/relay-action` (the
`<Connect action>`), then `GET /api/handoff/context?from=…` **from a browser, through Traefik** — the
screen pop. Twilio's own record: `outbound-dial → client:browser_agent`, completed. A person answered.

**One trace, four turns, four tools.** From ClickHouse (see the note below on why not the API):

| trace | started | turns | tools |
|---|---|---|---|
| `a01d08e1…` voice | 17:56:46 | **4** `turn.voice` | `lookup_order`, `search_knowledge`, `handoff`, `end_call` |
| `448f3c4b…` sms | 17:56:11 | **1** `turn.sms` | none — answered from Conversation Memory |

Four turns in **one** trace is the `conversation.voice` grouping working through the containers, and
`handoff` + `end_call` in the same call means the model both transferred and hung up.

**Single-reply SMS is confirmed: 1 inbound → 1 reply**, from `+1919…` (external). That is the control
for the doubling described above, and it lands exactly where the analysis predicted — so the doubling
really is an on-account artefact and there is nothing to fix.

**Telemetry export from inside the container is confirmed**, which closes the plan's silent-failure
worry (a well-formed but unreachable `LANGFUSE_BASE_URL` yields `caps.prompts = true` while every span
is dropped). `prompt.fetch`, `prompt.compose`, `memory.recall`, `tools.resolve`, `llm.stream`,
`invoke_agent`, `step 1`/`step 2` and `chat gpt-5.4-mini` spans are all present for both traces.

> ⚠ **Verifying traces: this Langfuse is v4 in `events_only` mode, so the READ API IS DISABLED.**
> `GET /api/public/traces`, `/observations` and `/metrics/daily` all return **404 with a message saying
> the endpoint is unavailable in this mode** — a 404 that means "disabled", not "no data", and reading
> it as the latter would have had us chasing a telemetry bug that did not exist. `/api/public/projects`
> and `/api/public/health` still work, and `/api/public/otel/v1/traces` is POST-only ingestion.
> The legacy `traces` / `observations` ClickHouse tables are **empty by design** — the data is in
> **`events_core` / `events_full`**:
> ```bash
> docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse \
>   --query "SELECT trace_id, name, count() FROM default.events_core
>            WHERE start_time > now() - INTERVAL 30 MINUTE GROUP BY trace_id, name"
> ```
> The Langfuse **UI** still works, which is what the "Verified waterfall" section above used.

### Still not exercised

- **The 45 s shutdown drain**, which needs a SIGTERM *during* a call — `docker compose stop agent`
  mid-call. The signal path is proven (see honest limits); the drain is not, and a fast clean exit with
  no call in flight says nothing about it.
- **A `/ws` signature rejection**, invisible by construction.

## Latency, investigated 2026-09-15 — the deferral has expired and the cause has MOVED

Dan reported voice latency as "kinda high" after a round of testing. Investigated against ClickHouse
`events_full`, since the read API is disabled (see the box above). **T9's framework conclusion still
holds and is no longer the useful explanation.** Our own code costs 84 ms. What dominates is the
**first** model round-trip of each conversation, against a system prompt that Conversation Memory has
grown **88% in one day** — a cause that did not exist at T9.

### The instrument this needed, and nothing here had been reading it

The AI SDK writes a **native time-to-first-chunk attribute on every `GENERATION`, in SECONDS**:

```bash
docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse \
  --query "SELECT formatDateTime(start_time,'%H:%i:%S') AS at,
             dateDiff('millisecond',start_time,end_time) AS span_ms,
             arrayElement(metadata_values, indexOf(metadata_names,
               'attributes.gen_ai.client.operation.time_to_first_chunk')) AS model_ttft_s,
             usage_details['input'] AS inp, usage_details['input_cached_tokens'] AS cached
           FROM default.events_full WHERE type='GENERATION'
             AND start_time > now() - INTERVAL 2 HOUR ORDER BY start_time"
```

Siblings on the same span: `attributes.gen_ai.client.operation.duration` and
`…time_per_output_chunk`. Across 33 generations `model_ttft_s` accounts for the generation span almost
exactly; the residual is streaming the remaining output, not overhead. **This turns "is it us or is it
the model?" into one query** — which is why nothing below is inferred.

### The 6214 ms turn, fully attributed — no residual

Worst turn of the most recent call (trace `1c835f9d…`, turn span `73cc06285891f6a0`, 19:33:21 UTC).
Every number is a span timestamp, and they close to within 1 ms of `turn.ttft_ms`:

```
21.438  turn.voice starts                                          t0
21.522  llm.stream starts                     +   84 ms   preamble: prompt.fetch 41 ∥ memory.recall 79
25.360  generation 1 first chunk              + 3838 ms   ← cold cache, 2520 input tokens
26.001  tool-call args finish → search_knowledge starts  +  641 ms   streaming 42 output tokens
27.019  search_knowledge returns              + 1018 ms   Twilio knowledge base
27.026  generation 2 starts                   +    7 ms
27.651  generation 2 FIRST CHUNK → first audio to caller  +  625 ms
        ────────────────────────────────────────────────────────────
        turn.ttft_ms = 6214 ms                  84 + 3838 + 641 + 1018 + 7 + 625 = 6213
```

Note `search_knowledge` starts at 26.001 while generation 1's span runs to 26.267 — the tool fires as
soon as its arguments are parsed, so the two overlap and the span durations do **not** sum to the turn.
Read the timestamps, not the durations.

### Four causes, in order of what they cost

**1. Model time-to-first-chunk is the entire latency. `runTurn` is not the place to look.** Preamble
0–84 ms across every turn measured. Tools: `lookup_order` 1 ms, `search_knowledge` 417–1018 ms,
`handoff` 266 ms. This is T9's conclusion re-confirmed with a better instrument.

**2. The memory block is now LARGER than the prompt we wrote, and it grows per call.**

**The longest baseline available is in this file.** The T14 status block above records
`memory.recall = 1 observation + 1 summary + 1 trait group → 696 chars` on 2026-09-14. One day later it
is **4412 chars — 6.3×**. (That T14 figure was an SMS conversation and the file does not record its
caller, so treat 6.3× as a scale reference rather than a same-caller series. The within-day series below
*is* same-caller and is the rigorous one.)

`memory.recall` `chars`, by conversation, 2026-09-15 (all the same caller, `+1919…`):

| UTC | channel | memory chars |
|---|---|---|
| 14:01 | voice | 2341 |
| 15:47 | bench | 0 — the bench sends no memory payload |
| 15:52 | sms | 1837 |
| 17:56 | sms **and** voice | 3303 — identical, so recall is caller-scoped, not channel-scoped |
| 19:33 | voice | **4412** |

Not strictly monotonic — 15:52 dips below 14:01, so Orchestrator **rewrites** rather than only
appending — but net **+88%** in a day. Prompt budget on generation 1 of the 19:33 call:

| component | chars | share |
|---|---|---|
| base voice prompt (Langfuse v6) | 4087 | 33% |
| **injected memory** | **4412** | **35%** |
| tool definitions (5) | 4035 | 32% |

⚠ Those are `chars ÷ 4` proportions. The tokenizer reported **2520** input tokens where `chars ÷ 4`
predicts ~3132, so it overestimates by ~24% — **trust the shares, not the absolute token counts.**

`server/twilio/memory-compose.ts` **caps nothing.** `RECALL_SECTIONS` takes whatever Recall returns and
`MemoryPromptBuilder.build` renders all of it; the only cap in that file is `MAX_CACHED_PROFILES`, which
bounds the profile *cache* and is unrelated to prompt size. Any bound has to come from the Orchestrator
capture rules or be added here.

The content is also degrading, which is a **quality** problem before it is a latency one — the model is
reading contradictory versions of one fact. Verbatim from the 19:33 prompt:

> "Has a previously placed order that was shipped and includes one desk lamp. Has a last order with the
> order number A4721. Previously has a previously placed order that was shipped and includes one desk
> lamp. Has a last order with the order number 4721."

Note `4721` against `A4721` inside a single observation, and four Past Conversation Summaries that all
recount the same return-policy call.

**Where the cost actually lands: the FIRST turn of every conversation.** Turns 2+ report
`input_cached_tokens` of 1536–2560, so OpenAI's prompt cache absorbs the bloat and they run 0.51–0.71 s.
Turn 1 pays it cold. That is precisely the turn a caller forms an impression on.

**3. A ~2-hour upstream slow patch — and it is the window T15 closed on.** Model TTFT by window:

| UTC window | model TTFT per generation | verdict |
|---|---|---|
| 14:01 | 1.61, 0.74, 1.02, 0.59, 0.80, 0.74, 0.70 | healthy |
| 15:47–15:55 | 2.00, 0.80, 1.25, 1.21, 0.54, 0.40, 0.77, 0.82, 0.69, 0.58 | healthy |
| **17:56–17:57** | **3.71, 4.74, 2.07, 2.26, 4.39, 4.74, 1.28, 2.90, 2.79** | **2–5× worse** |
| 19:33–19:34 | 3.83, 0.63, 0.58, 0.51, 0.57, 0.71, 0.55 | cold first turn, then healthy |

Not us, and provably so on three counts: container `ef371f7fbd13` served **both** the fast 15:52 call
and the slow 17:56 call, so it is not container cold start; prompt v6 and `model_parameters` were
identical throughout; and the **tool-free** SMS turn at 17:56:11 took **3835 ms** where tool-free turns
elsewhere took 586–801 ms, which isolates it from tool-cycle structure entirely.

⚠ **Consequence for this document: the T15 close-out call (`a01d08e1…`, 17:56:46) landed inside that
window.** Its `turn.ttft_ms` of 6934 / 7723 / 6850 / 6047 ms are the worst on record here — T13 measured
2405 → 463 ms and T14b 2472 / 2411 / 801 / 2257 ms. **Do not quote the T15 call as a latency baseline;
it is an upstream-variance sample.** It remains valid for everything T15 actually claimed (routing,
`/ws` upgrade, trace grouping, handoff) — none of which is timing-dependent.

**4. A tool turn's TTFT structurally contains the whole tool cycle.** Tool-free turn **586 ms**; tool
turns 1282–1433 ms at healthy model speed. Nothing is spoken while a tool runs. A design choice, not a
defect — and the reason a policy question always feels slower than a chatty one.

### Untried lever: reasoning effort is never sent

`model_parameters` is `{}` on **all 33** generations. `openai.ts`'s `stream()` has no `providerOptions`,
and `PromptConfigSchema` (`server/agent/prompt/port.ts`) admits only `model`, `temperature`, `maxSteps`,
`tools`, `toolChoice`. `gpt-5.4-mini` is a reasoning model, so it runs at the provider default effort.

**This is a hypothesis, not a measurement.** No reasoning-token attribute exists on the span at all —
`gen_ai.usage.*` carries only `input_tokens`, `output_tokens`, `cache_read.input_tokens`,
`cache_creation.input_tokens` — so the traces **cannot** tell you whether reasoning is costing time.
Wiring `providerOptions` would be needed to find out, and that is a code change plus a schema widening.

### The levers, best first

1. **Cap or dedupe the memory block.** Largest, entirely ours, actively worsening, and it improves
   answer quality as well as TTFT. Either bound observations/summaries in `memory-compose.ts`, or fix
   the Orchestrator capture rules so it stops writing near-duplicates — probably both, since the two
   fix different halves (prompt size vs. the contradictions).
2. **Prune tool definitions** — 4035 chars for five tools, paid on every turn:
   `search_knowledge` 1244, `handoff` 967, `end_call` 773, `get_store_hours` 529, `lookup_order` 512.
   ⚠ `search_knowledge`'s description is **load-bearing** — see the T14 section on why score cannot gate
   it. Trim it with that constraint in hand, or not at all.
3. **Try `reasoning_effort: 'low'` for voice.** Needs the `providerOptions` path built first.
4. **Speak a filler while a tool runs**, if tool turns should feel like tool-free turns.

### How to prove a fix worked — the two queries, so the next session does not rebuild them

**Memory-block size per conversation.** This is the number a cap has to move. `chars` is published by
`memory-compose.ts` onto its own `memory.recall` obs event, so it needs no code change to read:

```bash
docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse \
  --query "SELECT substring(trace_id,1,8) AS trace, formatDateTime(min(start_time),'%H:%i:%S') AS at,
             any(output) AS memory_chars
           FROM default.events_full WHERE name='memory.recall'
             AND start_time > now() - INTERVAL 24 HOUR
           GROUP BY trace_id ORDER BY at"
```

**The prompt budget, split into its three parts.** Pass the `span_id` of the first `GENERATION` of the
conversation. This is what produced the 33 / 35 / 32 % table:

```bash
docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse \
  --query "SELECT input FROM default.events_full WHERE span_id='<span_id>' FORMAT TSVRaw" > /tmp/gen1.json
python3 -c "
import json; d=json.load(open('/tmp/gen1.json'))
s=[m for m in d['messages'] if m['role']=='system'][0]['content']
i=s.find('# Customer Context'); base,mem=s[:i],s[i:]; tools=json.dumps(d['tools'])
for n,v in (('base prompt',base),('memory',mem),('tools',tools)):
    print(f'{n:<14}{len(v):>6} chars  {100*len(v)/(len(base)+len(mem)+len(tools)):>4.0f}%')
"
```

⚠ **Read `input` from `events_full`, not `events_core`** — `events_core` carries the same column but the
full serialised request is what this needs, and it is the one place the *actual* prompt the model saw is
recoverable. It includes the PII the honest-limits section warns about.

**Which process produced a trace** — `resourceAttributes.host.name` is a **docker hash** for a container
run and the **laptop hostname** for a `pnpm dev` run. This is how container cold start was ruled out
above (`ef371f7fbd13` served both a fast and a slow call), and it is the fastest way to tell whether a
trace came from the stack or from a host process you forgot was running:

```bash
docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse \
  --query "SELECT DISTINCT arrayElement(metadata_values,
             indexOf(metadata_names,'resourceAttributes.host.name')) AS host
           FROM default.events_full WHERE start_time > now() - INTERVAL 24 HOUR"
```

## Voice latency TIMELINE — user-perceived instrumentation, proven on a real call 2026-09-15

The latency section above answers *"how long did the model take"*. It could not answer **"what was
happening for the other 79% of the call"**, and that is what this adds. Before: `turn.voice` started at
the final transcript and ended when the LLM stopped streaming, so trace `d2e680b5…` (22:43 UTC, 6 turns,
**57.5 s**) showed **12.2 s of spans and 45.3 s of gap** — with no way to tell "bot was talking" from
"caller was talking" from "ASR was slow".

After, trace `a046b1cd…` (23:04 UTC, 6 turns, **42.7 s**, 86 observations) the root is **tiled**:

```
conversation.voice  42675 ms
├─ turn.voice   3181   asr.final ▪  tts.send 514   ttfa 2667  lookup_order + search_knowledge
├─ caller.turn  4190
├─ turn.voice   1288   asr.final ▪  tts.send 804   ttfa  484
├─ caller.turn  2849
├─ turn.voice   1594   asr.final ▪  tts.send 393   ttfa 1201  lookup_order
├─ caller.turn  6824
├─ turn.voice   2064   asr.final ▪  tts.send 409   ttfa 1655  lookup_order
├─ caller.turn  6265
├─ turn.voice    884   asr.final ▪  tts.send 337   ttfa  547
├─ caller.turn  7494
└─ turn.voice   3649   asr.final ▪  tts.send 150   ttfa 3499  handoff
   root metadata: turns.count=6  turns.aborted=0  caller.turn_total_ms=27622
                  turn.ttfa_p50_ms=1201  turn.ttfa_max_ms=3499  closedBecause=ended
```

**Measured coverage: the gap between every consecutive root child is 0 ms.** Two residuals, both
explainable and neither a gap in the instrumentation:

- **head −1 ms.** Turn 1 starts one millisecond BEFORE the root, because `promptAt` is captured as the
  first statement of `handleVoicePrompt` while the root span is created lazily a moment later by
  `conversations.traceparentFor`. Back-dating the turn is the point, so this is the correct sign.
- **tail 2394 ms.** From the last `last: true` to the socket closing — the final reply still playing to
  the caller, plus the hangup. Nothing we own can shorten or see inside it (see the honest limit below).

### What the numbers actually say, including the one that disappoints

**`caller.turn` is where the call lives: 27622 ms of 42675, i.e. 65%.** And `tts.send` is only
**150–804 ms** per turn, so the overwhelming majority of each `caller.turn` is TTS playback, caller
speech and ASR endpointing — *not* our token streaming. That is the whole reason the span is named
`caller.turn` and documented as a blend rather than as "caller talking".

⚠ **`turn.ttfa_ms` came back within 0–3 ms of `turn.ttft_ms` on all six turns** (2667/2664, 484/481,
1201/1201, 1655/1654, 547/546, 3499/3498). This is a genuine result and not a bug: the anchor is the
instant our generator yields the first non-empty delta, and TAC's `sendStreamingResponse` does
`ws.send` **synchronously in the same `for await` iteration**. So ttfa proves nothing is queueing
between the model and the socket — a useful negative — but **do not expect it to reveal TTS or
playback cost, and do not present it to anyone as time-to-first-audio.** It is a server-side proxy and
the residual it cannot see is the part a caller hears.

### Four things that were wrong on the first pass, all found by review before commit

1. **`spoken !== ''` is the WRONG guard for "the `last: true` marker went out".** TAC's
   `sendStreamingResponse` accumulates `fullResponse += chunk` **before** `ws.send`, and both of its
   `break`s (aborted signal, closed socket) fall through to `return fullResponse` — so a socket that
   dies mid-stream returns a non-empty partial while no marker was ever sent. The guard now mirrors the
   bundle's own: non-empty **and** not aborted **and** the socket still open. Such a turn records
   `turn.ending: 'no-output'`.
2. **Ending the turn span from inside `handleVoiceInterrupt` silently costs the barged-in turn its
   attributes.** `runTurn` writes `output`, `tools.called` and `turn.total_model_ms` after `await done`,
   which lands *after* the interrupt — on an already-ended span, where OTel drops it. The interrupt
   handler therefore **parks the boundary instant** and the prompt handler's `finally` closes the span
   *at* that instant. Do not "simplify" the interrupt handler into closing the span itself.
3. **`forget()` finalises before it reports.** It completes a still-live turn and then returns the
   statistics, so requirement 6's root metadata cannot be computed from a half-open call. There is no
   `stats()` to call in the wrong order any more, deliberately.
4. **`endOnExit: false` on `withTurnSpan` is cosmetic**, because the `finally` closes the span first and
   OTel's second `end()` is a no-op that keeps the first end time. It is kept for intent, and the
   docblock says so rather than overclaiming. Its real cost is that a post-`end` `setStatus` is dropped,
   which is why the error path writes `level: 'ERROR'` **before** the `finally`.

### Two vendor facts worth not rediscovering

- **TAC 2.2.0 drops `lang`.** `PromptMessageSchema` parses `lang: z.string().optional()` and
  `handlePromptMessage` then forwards only `{conversationId, transcript, abortSignal, userMemory?,
  session?}`. The forwarding is wired here anyway so it lights up if TAC adds it; today `asr.final`
  carries no `lang` attribute at all — Langfuse's `_serialize(null)` returns undefined, so a null
  metadata key produces no attribute rather than an explicit null.
- **No anchor we own can precede TAC's memory Recall.** `handlePromptMessage` awaits
  `retrieveMemoryIfEnabled` *before* calling our handler, and voice runs `memoryMode: 'once'`, so on
  turn 1 a Conversation Orchestrator round-trip sits inside `caller.turn` and not inside `turn.voice`.
  That is recorded in the `caller.turn` code comment; it is also why `caller.turn` must not be read as
  a pure human-speech measurement.

### How to re-prove it

```bash
npx vitest run tests/voice-telemetry.test.ts   # 23 tests over real spans, in-memory exporter
node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-telemetry.ts
```

The test harness needs an `AsyncLocalStorage` context manager and a local traceparent propagator:
with a bare `BasicTracerProvider`, `context.with` is a **no-op** and the first run of this test
reported **six trace ids for one call**. No new dependency — `@opentelemetry/context-async-hooks` is
already transitive. The harness cannot exercise `LangfuseSpanProcessor`'s filters, which is why the
live-stack run above is the real proof.

⚠ **The interrupt path is NOT proven on real traffic.** Both calls above have `turns.aborted=0` and no
`tts.interrupted`, so `durationUntilInterruptMs` on a live barge-in has only been seen from the test and
the diagnostic. Talking over the agent on the next call is all it takes; until then treat that one branch
as unverified.

## Gaps and honest limits

- **Latency: no longer deferred, and now measured properly — see "Latency, investigated 2026-09-15"
  above, which supersedes this bullet.** T9's finding (preamble 46 ms; cost is in sequential model
  round-trips, not `runTurn`) was re-confirmed with the native `time_to_first_chunk` attribute. What T9
  could not see is that the dominant term is now the **cold first turn** against a memory block that has
  grown to 52% of the system prompt. Compare to spike S1's 1112 ms only carefully; that was a
  single-step turn.
- **`gpt-5.4-mini` is a reasoning model and silently ignores `temperature`.** The AI SDK warns twice
  per turn. `temperature` was therefore dropped from the compiled defaults, but **live Langfuse
  prompt v2 still sets `0.4`** — an operator edit, deliberately not policed in code.
- **PII does reach Langfuse.** Our own spans and events are scrubbed (verified `+1***4567`), but the
  AI SDK's model spans carry the full prompt and completion. That is largely the point of tracing,
  and the stack is self-hosted per demo — but do not describe this app as keeping PII out of Langfuse.
- **t0 is our first observation, not STT arrival.** Un-measurable upstream: WS frame parse,
  `startStreamTask`, and TAC's `promptQueues` serialisation (`voice.ts:630`). `turn.ttft_ms` is now
  turn-relative and `turn.ttft_model_ms` model-relative; neither includes the upstream gap.
- **TTS first byte and playback end are NOT measurable from here, so `turn.ttfa_ms` is a proxy and
  measures within 0–3 ms of `turn.ttft_ms`.** ConversationRelay exposes neither: `tokens-played` appears
  in the attribute table and in no websocket-message reference, and TAC drops unrecognised inbound frames
  before dispatch anyway. The residual shows up as the trailing 2394 ms between the last `last: true` and
  the socket closing, and as the bulk of every `caller.turn`. Getting the real number means Voice Insights
  or a switch to Media Streams `mark` events — both out of scope. See "Voice latency TIMELINE" above.
- **`caller.turn` is a BLEND and must never be presented as caller speech.** Bot playback + caller
  speech + ASR endpointing, plus TAC's memory Recall on turn 1 (it awaits `retrieveMemoryIfEnabled`
  before calling our handler, so no anchor we own precedes it). Measured at 65% of a real call.
- **The live barge-in path is unverified.** `tts.interrupted` and `turn.aborted: true` are proven by
  `tests/voice-telemetry.test.ts` and `scripts/verify-telemetry.ts`; both real calls so far have
  `turns.aborted=0`. One call where somebody talks over the agent closes this.
- **Langfuse v4 `events_only` has no public read API for traces.** `/api/public/traces`,
  `/observations`, `/metrics/daily` all 404; `/events` and `/spans` are POST-only. Prompts read fine
  via `/api/public/v2/prompts`. Trace verification is a **UI check via Playwright MCP**, never an API
  assertion. (Reading ClickHouse directly works for debugging ingestion, as at correction #3.)
- **History is process-local and dies with the container.** By decision, not oversight — the plan
  rules out a second durable store and Langfuse owns durable history. Consequences to state out loud:
  a `node --watch` restart drops every conversation mid-call, and a two-instance deploy would not
  share them. The escape hatch is documented in `history.ts`'s header, and it is not free: a networked
  store makes `read` async, which then belongs in the `Promise.all` beside the prompt fetch rather
  than in front of it.
- **What the bench does NOT prove, and T20's README must say so.** It exercises `runTurn` end to end
  with no Twilio, which is real but bounded. Not covered: webhook signature validation,
  ConversationRelay STT/TTS latency, barge-in on a live call, TAC memory retrieval, `session.metadata`
  surviving a real conversation, orchestrated-mode memory writes, and Studio handoff. The bench's
  abort path is a closed browser tab, which is a plausible stand-in for a barge-in and not the same
  thing.
- **The TAC-free claim is stronger than the architecture test.** `tests/architecture.test.ts` checks
  import strings, which a file can satisfy by not having got round to importing TAC. The real check
  was run: `node_modules/twilio-agent-connect` moved aside, agent booted, `/health` 200, and a
  complete 25-token turn with a real tool call and 2 steps — zero module-resolution errors. TAC is a
  declared dependency and *is* installed, so this is not vacuous. **T12 has now added the TAC boot, so
  this is no longer trivially true and re-running it is the one outstanding check that costs nothing.**
  Two cases, and the second is the real one: credentials ABSENT (the dynamic import in `index.ts` never
  evaluates) and credentials PRESENT (the import rejects, the try/catch degrades, `/bench` still serves).
- **BOTH channels are verified live, now including memory ACROSS conversations and a handoff to a
  human.** Ten SMS turns and five calls (24 voice turns total) have round-tripped, including memory
  across a conversation boundary with 0 tool calls, barge-in on real audio, the not-found tool branch,
  an agent-initiated hangup, `search_knowledge` against a real Knowledge Base on both channels, and — at
  T14b — a caller transferred to a browser softphone that a person answered, with the screen pop
  rendered. What remains unexercised: the **45 s shutdown timeout** (needs a SIGTERM *during a call*)
  and a **`/ws` signature rejection** (invisible by construction).

  **T15 closed the cheaper half of the shutdown question and left the expensive half open — the
  distinction matters, so do not read it as done.** Proven at T15: `docker compose stop agent` with an
  SSE client attached logs `Received shutdown signal`, drains TAC, shuts the SSE hub, force-closes a
  request that had been held open 184.7 s, and exits **0** in **under a second** against a 60 s
  `stop_grace_period`. That proves three things at once — the exec-form `CMD` really does forward
  SIGTERM (a shell-form `CMD` would have swallowed it and eaten the whole 60 s), `forceCloseConnections`
  really does defeat a held-open SSE connection, and `preClose` runs rather than a watchdog `exit(1)`.
  Still **not** proven: the 45 s path itself, which only engages when TAC has a live WebSocket to drain.
  That needs a SIGTERM mid-call, and a fast clean exit with no call in flight tells you nothing about it.

  **Studio handoff is no longer on that list**, and it was right up to T14b. T14b's one open measurement is now closed too: extraction **does**
  still fire for a handed-off conversation — it reached CLOSED in 32 s and wrote 3 observations 3 s later,
  even with its status callbacks cleared. See the end of the T14b section for why the inference that it
  would not was wrong.
- **The demo's memory story needs TWO conversations and a five-minute gap, and that is a product fact,
  not a limitation to engineer around.** Extraction is post-conversation only. A demo script that texts
  once and expects the agent to remember will fail, correctly. Either seed a profile beforehand or
  build the pause into the narrative — the pause is also where you explain what Orchestrator is doing.
- **PII now reaches the memory store as well as Langfuse.** The profile's traits are a phone number,
  and extracted observations are prose derived from the transcript. `obs/pii.ts` scrubs our log lines
  and obs payloads — it does **not** scrub tool results or the memory store. `builtin-tools.ts`
  projects communications down and drops `recipients` so an address cannot reach the model through a
  tool result, and a test asserts it; the store itself is Twilio-side and out of our control.
- ~~`docker-compose.yml` for the app does not exist yet (T15).~~ **Done at T15.** Both containers run
  behind Traefik on one public host. The dormant test this bullet used to warn about is now **live and
  proven falsifiable** — see the T15 section.

  The warning is kept below because its *second half was wrong*, and the wrong version is the more
  memorable one:

  1. ✅ Still exactly right: a literal `` PathPrefix(`…`) `` is required for **every** entry in
     `TAC_WEBHOOK_PATHS` *and* `APP_API_PATHS` — eight of them. Substring-matched, so the rule must be
     written in the backtick form, on one physical line.
  2. ❌ **CORRECTED AT T15 BY MEASUREMENT.** This bullet claimed that without the
     `customrequestheaders.X-Forwarded-Proto = https` label **"every webhook 403s — a silent, total
     outage"**. That is false on this box, for two independent reasons:
     - this Traefik runs `forwardedheaders.trustedips=172.16.0.0/12`, and the Caddy that terminates TLS
       arrives from inside that range, so Traefik **preserves** the genuine `X-Forwarded-Proto: https`
       rather than overwriting it (verified through the public ingress);
     - TAC's own `getForwardedProto` is `raw?.split(',')[0]?.trim() || "https"` — it **defaults to
       https when the header is absent** anyway.

     Keep the label: it is real defence in depth, because the Traefik container's compose project
     points at `~/code/twilio-laptop-setup`, which **is no longer on disk**. A recreated Traefik could
     come back without `trustedips`, and that is the day this label earns its place. But do not go
     hunting for a 403 outage that this label prevents — it does not prevent one today.

  T14b added three routes, all under `/api`, so they need no new prefix. `/softphone` is a **Next**
  page on the web container while the token and screen-pop endpoints it fetches are on the **agent** —
  the `/api` prefix is what makes that straddle work, and T15 confirmed it live: `GET
  /api/bench/turn` returns Fastify's JSON 404 (the agent) while `/nope` returns Next's HTML 404.
- ⚠ **NAMED DEBT, INTRODUCED BY T15: four unauthenticated endpoints are now permanently addressable on
  a stable, guessable public host.** Nothing about them changed — what changed is their reachability.
  The ngrok URL was ephemeral *and* obscure; `northwind.twilio.dtolb.com` is neither, and it stays up.

  | endpoint | what it gives away |
  |---|---|
  | `POST /api/voice/token` | mints a **real Twilio Voice AccessToken** for `CLIENT_IDENTITY`. Capability-gated, **not** auth-gated — verified live at T15, it returns a valid JWT to an anonymous caller |
  | `POST /api/bench/turn` | spends the `OPENAI_API_KEY`, unmetered |
  | `POST /api/dev/emit-turn` | fabricates observability events, so the console can be spoofed |
  | `GET /health` | lists the **names** of unset variables (not values) |

  **Why basicauth is not the bolt-on it looks like**, recorded so the next attempt does not rediscover
  it: Traefik answers `401 WWW-Authenticate: Basic`, which browsers honour **only for top-level
  navigations**. `fetch()` receives a bare 401 with no dialog, and `EventSource` **cannot send an
  `Authorization` header at all** — so guarding `/api/*` and `/events` while leaving the pages open
  silently kills the softphone, the bench and the obs console. Making it work means guarding the **web
  router too**, which puts a password box in front of T18's customer-facing demo page.

  It was proposed at T15 planning and **deliberately withdrawn by the owner** — get it live and testable
  first, then protect it. This is the record of that decision, not an oversight. **Mitigation until
  then: bring the stack down between demos** (`pnpm stack:down`); it is two containers and one command.

  **Partly automated 2026-09-15.** The stack now runs `restart: "no"`, so **it does not come back by
  itself after a reboot** — the tooling does (Langfuse is `always`) but the public surface requires an
  explicit `pnpm stack:up`. Measured over two full Colima cycles, and `on-failure` was tried first and
  is NOT safe here: it also restarts a container that exited non-zero, and on a VM stop the agent exits
  **0** (its graceful shutdown works) while Next exits **143**, so `on-failure` left the agent down and
  brought `web` back. A policy whose reboot behaviour depends on each process's SIGTERM handling is not
  a policy. Note `restart: no` unquoted is a YAML boolean — it must be `"no"`.

  This reduces the exposure window to "while you are demoing" without touching the auth question, which
  is still deferred.
- Carried Minor review findings, for a final whole-branch review: a duplicated prose block across
  the two default prompts; `log.warn` outside the never-rejects guard in `prompt/langfuse.ts`;
  `telemetryLink: unknown | null` collapsing to `unknown`; `verify-tools.ts` no longer reproducing
  the mixed-partition case on demand. **T14b's own whole-feature review is done** — one session, four
  Important and six Minor, all ten fixed in a single commit; the two bugs worth remembering are recorded
  in the T14b section. Two Minors were accepted as-is there: `isTacToolName('handoff')` is a tautology
  given the line above it, and `tests/shared-purity.test.ts`'s `startsWith` has no path-segment boundary
  (so `/apifoo` counts as under `/api`) — which matches its own sibling assertion, making a change a
  consistency regression rather than a fix.

## Conventions worth not breaking

- **Boot never hard-fails** on environment or configuration. Empty env → loud per-variable warnings,
  `/health` 200, 503 naming the variable. `TACConfig.fromEnv()` throws, so only call it once
  `config.twilio !== null`. The mirror image also holds: **fail loud at boot on a code error** — a
  duplicate tool name throws when the catalog is built, which is deliberate and ratified.
- **`server/config.ts` is the one place the environment is read.** `server/agent/` contains zero
  `process.env` reads; keep it that way. (`logging.ts` and `obs/instrumentation.ts` are pre-existing
  exceptions — the pino instance and the `--import` preload both run before config could load.)
- **`shared/` is data.** Compiled by both projects, so no Node global and no DOM global.
- **Vendor boundaries are tested.** Only `server/twilio/` may import TAC — and, since T14b, the
  `twilio` package under the same rule, which is why token minting lives there and is injected into
  `server/http/`; only `agent/model/openai.ts` may import `ai` (plus `obs/instrumentation.ts` for
  `registerTelemetry` ONLY, itself asserted); only `agent/prompt/langfuse.ts` may import
  `@langfuse/client`. Prove a guard bites before trusting it — every rule was validated by deliberately
  breaking it.
- **No `console.*`** anywhere under `server/` or `web/src/` — it bypasses the PII scrubber.
  `scripts/` is exempt.
- **Verify at the layer where the failure can live.** Both T11 bugs were invisible to the tests written
  for them and cost nothing to find once the right instrument was used. A framework-lifecycle bug
  (`request.raw` vs `reply.raw`) needs a real socket — a unit test that injects the signal cannot see it.
  A layout bug (a clipped author label) needs a **screenshot** — it was absent from the accessibility
  snapshot, from `innerText`, and from every width/overflow assertion, all of which passed. "Verify by
  running the thing" is not only about running it; it is about running it where the failure lives.
- **Zod is the single source of truth for tool schemas**, and `config.tools` in a prompt carries
  **names only** — so a Langfuse edit selects from a code-owned allowlist and structurally cannot add
  a tool or change a schema. `toJsonSchema` uses `io: 'input'`; its docblock explains why, and what
  the input projection drops.
- **No mocking library, no snapshots.** `TurnDeps` makes injection the only seam needed, so *"if it
  needs `vi.mock`, the seam is wrong"* stays an enforceable review rule. Injected clocks, not sleeps.
- `.env` via Node's `--env-file-if-exists`, not dotenv.
- Comments explain *why* and cite what was measured. Read `server/obs/spans.ts` or
  `server/agent/run-turn.ts` before writing one.
- See `web/README.md` for the Strix and Next rules — several are silent-failure traps.
