# Handoff — demo scaffold

Updated 2026-09-11. Read this first, then `~/.claude/plans/i-want-to-build-reactive-muffin.md`
for the full plan and the footgun list.

**The plan is wrong in twelve places now.** Three concern telemetry and prompt linking — corrected in
"Corrections to the plan" below and in the plan's own footgun table (#30–#32); all three fail
*silently*. The other nine were found while building T12 and are listed under "T12, TAC boot for SMS".
Read whichever section matches what you are about to touch. Do not re-derive them; each was verified by
executing it, not by reasoning about it.

**Account-specific values are deliberately NOT in this file.** SIDs, phone numbers, Conversation
Orchestrator ids and Studio flow SIDs live in `.env` (gitignored) and in this project's session memory
at `~/.claude/projects/-Users-dtolbert-code-demo-building-tools-scaffold/memory/`. This repo is
*cloned* per demo, so a committed doc carrying one account's ids hands every future clone stale values
that look authoritative. What is here instead is the **method** for discovering them — see
"Twilio credentials" below.

There is a published walkthrough written for a human rather than an agent:
<https://pages-4296.twil.io/scaffold-next-steps> (public, no auth — no credentials on it).
⚠ **It predates T12 and is now stale**: it presents gathering Twilio credentials as the next step and
does not know SMS works. Re-publish it before showing it to anyone, or treat this file as the only
current source.

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

## Status: T1–T12 done, all four spikes closed

```
pnpm typecheck   → 0          (TS 7.0.2, node project + web project)
pnpm test        → 228 passed, 13 files
```

**T12 IS DONE AND PROVEN AGAINST REAL SMS.** Two live turns on `+15805630929`, measured:

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
| **T12 TAC/SMS** | done — a real text to `+15805630929` is answered, turn 2 recalled the order number with **0 tool calls**, and the `conversation.sms` trace tree is confirmed in the Langfuse UI |
| **T13 TAC/voice** | **built, boots, and proven up to the WebSocket — no call placed yet.** A signed simulated webhook returns correct ConversationRelay TwiML. The live call is the one remaining step |

**Not started:** T14 built-in tools + memory, T15–T17 Docker/Traefik, T18–T20 UI + docs.

**A human can talk to the agent three ways now** — `pnpm dev:all` then
<http://localhost:3000/bench>, **text the number**, or **call it**, the last of which has been built
and pre-flighted but not yet dialled. Still absent: Docker for the app, and the home page is a
placeholder.

## Running it

```bash
pnpm status        # what's up, what's configured, what's therefore possible. Read-only.
pnpm langfuse      # the 6-container Langfuse stack (~2.7 GB, ready in ~10s on warm volumes)
                   # ⚠ if docker is dead, see "colima wedged" below BEFORE retrying — the retry
                   #   fails with an exit code of 0 and a fatal on stderr, which reads as success
pnpm dev:all       # agent :8910 + web :3000, ctrl-c stops both cleanly
pnpm typecheck && pnpm test
pnpm seed:prompts  # push the compiled defaults to Langfuse as v1 + `production`

# the four live diagnostics — each answers a question you cannot answer by reading code
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
**SMS works**. Since T13 `TWILIO_VOICE_PUBLIC_DOMAIN` is set to the ngrok host as well, so
`capabilities().voice` is true and voice boots — it was the only variable SMS did not need. Only
`TWILIO_STUDIO_HANDOFF_FLOW_SID` remains unset, and leaving it that way is currently *helpful*: with
it set, TAC repoints the ConversationRelay `action` at Studio and `/conversation-relay-callback` is
never hit. Note the shell also exports real `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` /
`TWILIO_API_SECRET` from the user profile, so those three read as present whatever `.env` says — a clone
on another machine behaves differently.

**Inbound SMS needs a public URL.** There is no Docker/Traefik yet (T15), so the loop is an ngrok
tunnel to `:8910` with the CO configuration's `statusCallbacks[0].url` pointed at
`https://<host>/webhook`. That URL is baked into the configuration, so it must be repointed whenever
ngrok restarts — and updating it is a **full-replace PUT** where every omitted field is deleted.

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
    memory.ts       passthrough MemoryComposePort (TAC's real one lands at T14)
    history.ts      bounded per-conversation transcript. Caps + eviction policy in its header.
    prompt/         port.ts · langfuse.ts · defaults.ts · slots.ts
    tools/          registry.ts · catalog.ts · resolve.ts
    model/          port.ts · openai.ts  (the ONLY file importing `ai`)
  http/
    app.ts          buildApp(deps). Testable without a socket. /api/dev/emit-turn lives here.
    sse.ts          SseHub: heartbeat, drop-on-throw, transport-agnostic
    routes-obs.ts   GET /events/stream (SSE) + /events/recent
    routes-bench.ts POST /api/bench/turn. MUST NOT import TAC — that rule is the whole point.
  twilio/           the ONLY dir allowed to import twilio-agent-connect
    tac.ts          bootTac — ONE function, both channels, because there is only one TACServer.
                    SMS: registerChannel BEFORE new TACServer or /webhook is never registered.
                    Voice: passed to TACServer and NEVER registered, or our prompt slot is replaced.
                    Also owns the fastify-graceful-shutdown registration — read that constant.
    messaging.ts    one inbound SMS → runTurn → the reply string. Never throws, never returns ''.
    voice.ts        one ConversationRelay turn → runTurn → tokens spoken as they arrive. Read its
                    header: every failure mode on this channel is silence.
  obs/
    instrumentation.ts  --import preload. NodeSDK + LangfuseSpanProcessor + registerTelemetry.
    spans.ts            THE span API. Read its header before touching telemetry.
    first-token.ts      TTFT. Pure, fake clock. `collect()` here is what SMS uses.
    bus.ts              never throws on the product path; scrubs payloads once, at the boundary
    pii.ts              our own scrubber. Ancestor-path cycle detection + a depth bound.
    conversations.ts    per-conversation trace roots, swept + capped. Bench and SMS share it, and for
                        SMS it is the traceparent carrier IN PREFERENCE to TAC's session.metadata.
shared/               types + pure constants ONLY. Compiled by BOTH tsconfigs.
web/                  Next 16 + Strix. Own package.json, own lockfile, own .npmrc.
tests/                vitest. No mocking library, no snapshots — injection instead.
scripts/              status · dev · seed-prompts · verify-{model,prompts,tools,turn,telemetry}
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
`TWILIO_VOICE_PUBLIC_DOMAIN` and `TWILIO_STUDIO_HANDOFF_FLOW_SID` are still unread until T13/T14 — and
note SMS does **not** need the voice domain, which the plan assumed it would.

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
9. **`memoryMode: 'never'`, NOT the plan's `'always'`.** With `'always'` TAC folds a
   `## Recent Message History` block of `User:`/`Assistant:` lines built from Recall scoped to the
   *current* conversation — which `server/agent/history.ts` already puts into the model's messages. The
   model would see every conversation **twice, in two formats**. Note the round-trip is *not* the
   reason to avoid it: TAC Recalls before invoking our callback either way, so discarding costs the
   same. **T14 owns turning memory on properly**, with `MemoryPromptBuilder.build` (which also supplies
   the profile-traits section a hand-rolled `buildMemoryPrompts().join()` drops) and the current
   conversation excluded from communications.

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

### Proven for free, before any call

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
<Connect action="https://<host>/conversation-relay-callback">
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
points at us, not Studio — `resolveActionUrl` would silently redirect it to Studio if
`TWILIO_STUDIO_HANDOFF_FLOW_SID` were set, and our callback route would then never be hit.

**Not proven, and only a real call can:** the `/ws` upgrade and its signature, STT/TTS latency,
barge-in on real audio, the orchestrated first-turn CO poll (10 attempts, ~11 s ceiling), and whether
`X-Forwarded-Proto` survives the upgrade. Also note the SIGTERM check above passes on the 10 s default
too, because nothing had a WebSocket open — **the 45 s timeout only proves itself on a live call.**

### The three things in `voice.ts` that are not optional

1. **`sendStreamingResponse` is passed `{ signal }`.** TAC resolves
   `options?.signal ?? activeTask?.controller.signal`, and `cancelStreamTask` aborts the controller
   **and then deletes the map entry** — so on a barge-in the fallback is `undefined`,
   `signal?.aborted` is falsy forever, and the caller is talked over with the answer they just
   interrupted. `tests/voice.test.ts` asserts it is *our* signal; removing the option fails that test
   with `expected [ undefined ]`, which is exactly the production symptom. **Proven to bite.**
2. **`reportInputDuringAgentSpeech: 'any'`** in `VOICE_TWIML_OPTIONS`. The ConversationRelay default
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

`+15805630929` could not receive voice at all: it was the **only** number on SIP trunk
`DtolbLabsTesting` (`TKb1f1254299f6f8b5985e5bad8c0a12fb`), the trunk had **zero origination URLs**, and
a trunked number ignores its own `voice_url`. So:

| | Before | After |
|---|---|---|
| `trunk_sid` | `TKb1f1254299f6f8b5985e5bad8c0a12fb` | `null` (trunk now holds no numbers) |
| `voice_url` | `null` | `https://<ngrok-host>/twiml`, POST |
| `sms_url` | `""` | `""` — untouched; SMS still arrives via the CO `statusCallbacks` |

The number's real SID is **`PNf16baa0aba70fe744717166d10d8108c`**. ⚠ `PN1dbf1c0a094e37430258834f8372f2a2`
is `+13465978739`, a different, unused number — do not confuse them. And a trap found the hard way:
**`DELETE /Trunks/{TK}/PhoneNumbers/{PN}` returns 204 for a number that was never on the trunk**, so a
204 is *not* evidence that anything was detached. Verify with
`GET /Trunks/{TK}/PhoneNumbers` afterwards.

`TWILIO_VOICE_PUBLIC_DOMAIN` is the ngrok host, so **two** things must be repointed when the tunnel
restarts: this variable *and* the number's `voice_url` — on top of the CO `statusCallbacks` that SMS
already needed.

### T13 prerequisites discovered while doing T12

> **READ THIS FIRST: where TAC's source is.** `node_modules/twilio-agent-connect` is **dist-only** —
> `dist/index.js`, `dist/index.d.ts`, `dist/index.js.map`, **zero `.ts` files, no `packages/`**. So the
> `packages/server/src/lib/server.ts:242-259` style citations in the plan and in this file do **not**
> resolve there. They resolve in a **sibling checkout**:
> `/Users/dtolbert/code/demo-building-tools/twilio-agent-connect-typescript`, clean at tag **`v2.2.0`
> (`a7a58f2`)**, matching the installed version. Two path traps inside it: **`voice.ts` lives at
> `packages/core/src/channels/voice.ts`** (1745 lines), *not* under `packages/server/`; and **TAC ships
> no tests**, so a `tests/server.test.ts` citation is not test-backed evidence.
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

## Gaps and honest limits

- **Latency is deferred by decision, not oversight.** Measured at T9: `turn.ttft_ms` **3124 ms**,
  `turn.total_ms` 3582 ms, preamble (prompt fetch + recall + compose + resolve) only **46 ms**. The
  waterfall attributes it to **two sequential model round-trips** (2.12s + 2.50s), so it is a
  model/prompt/tool-shape question — `maxSteps`, whether both tools can resolve in one step, whether
  a reasoning model suits voice — not something tunable inside `runTurn`. Dan's call: address it once
  the full stack is wired. Compare to spike S1's 1112 ms only carefully; that was a single-step turn.
- **`gpt-5.4-mini` is a reasoning model and silently ignores `temperature`.** The AI SDK warns twice
  per turn. `temperature` was therefore dropped from the compiled defaults, but **live Langfuse
  prompt v2 still sets `0.4`** — an operator edit, deliberately not policed in code.
- **PII does reach Langfuse.** Our own spans and events are scrubbed (verified `+1***4567`), but the
  AI SDK's model spans carry the full prompt and completion. That is largely the point of tracing,
  and the stack is self-hosted per demo — but do not describe this app as keeping PII out of Langfuse.
- **t0 is our first observation, not STT arrival.** Un-measurable upstream: WS frame parse,
  `startStreamTask`, and TAC's `promptQueues` serialisation (`voice.ts:630`). `turn.ttft_ms` is now
  turn-relative and `turn.ttft_model_ms` model-relative; neither includes the upstream gap.
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
- **SMS is verified live; VOICE is built but no call has ever been placed.** Four real SMS turns have
  round-tripped (two at T12, two more on 2026-09-11 for the trace check). Voice boots, serves correct
  signed ConversationRelay TwiML, and is tested on its three exit paths — but the `/ws` upgrade,
  STT/TTS latency, barge-in on real audio and the orchestrated first-turn CO poll are all unexercised,
  and the 45 s shutdown timeout only proves itself with a socket open. Don't run a demo end-to-end
  without asking; calls and messages are billed.
- `docker-compose.yml` for the app does not exist yet (T15). The Langfuse compose does.
- Carried Minor review findings, for the final whole-branch review: a duplicated prose block across
  the two default prompts; `log.warn` outside the never-rejects guard in `prompt/langfuse.ts`;
  `telemetryLink: unknown | null` collapsing to `unknown`; `verify-tools.ts` no longer reproducing
  the mixed-partition case on demand.

## Conventions worth not breaking

- **Boot never hard-fails** on environment or configuration. Empty env → loud per-variable warnings,
  `/health` 200, 503 naming the variable. `TACConfig.fromEnv()` throws, so only call it once
  `config.twilio !== null`. The mirror image also holds: **fail loud at boot on a code error** — a
  duplicate tool name throws when the catalog is built, which is deliberate and ratified.
- **`server/config.ts` is the one place the environment is read.** `server/agent/` contains zero
  `process.env` reads; keep it that way. (`logging.ts` and `obs/instrumentation.ts` are pre-existing
  exceptions — the pino instance and the `--import` preload both run before config could load.)
- **`shared/` is data.** Compiled by both projects, so no Node global and no DOM global.
- **Vendor boundaries are tested.** Only `server/twilio/` may import TAC; only
  `agent/model/openai.ts` may import `ai` (plus `obs/instrumentation.ts` for `registerTelemetry`
  ONLY, itself asserted); only `agent/prompt/langfuse.ts` may import `@langfuse/client`. Prove a
  guard bites before trusting it — every rule was validated by deliberately breaking it.
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
