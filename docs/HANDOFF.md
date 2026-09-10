# Handoff — demo scaffold

Updated 2026-09-10. Read this first, then `~/.claude/plans/i-want-to-build-reactive-muffin.md`
for the full plan and the footgun list.

**The plan is wrong in three places.** They are corrected in "Corrections to the plan" below and in
the plan's own footgun table (#30–#32). All three fail *silently*. Read that section before you touch
telemetry or prompt linking.

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

## Status: T1–T11 done, all four spikes closed

```
pnpm typecheck   → 0          (TS 7.0.2, node project + web project)
pnpm test        → 227 passed, 13 files
```

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

**Not started:** T12–T14 TAC, T15–T17 Docker/Traefik, T18–T20 UI + docs.

**A human can now talk to the agent.** `pnpm dev:all`, open <http://localhost:3000/bench>, type. There
is still no TAC, no Twilio, no Docker for the app, and the home page is a placeholder.

## Running it

```bash
pnpm status        # what's up, what's configured, what's therefore possible. Read-only.
pnpm langfuse      # the 6-container Langfuse stack (~2.7 GB, ready in ~10s on warm volumes)
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

`.env` has a real `OPENAI_API_KEY` plus local Langfuse config. **No Twilio credentials**, so voice and
SMS are unavailable; the app boots anyway and says so. Note the shell also exports real
`TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET` from the user profile, so those three
read as present.

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

This is a real screenshot-confirmed tree, not a sketch:

```
conversation.bench                     SPAN
└─ turn.bench                          SPAN     11 attributes, all exact names
   ├─ prompt.fetch          0.04s      SPAN     cache hit ≈ 0ms, which is the point
   ├─ memory.recall                    SPAN     concurrent with prompt.fetch
   ├─ prompt.compose                   SPAN
   ├─ tools.resolve                    SPAN
   └─ llm.stream            4.64s      SPAN
      └─ invoke_agent gpt-5.4-mini     AGENT    the AI SDK emits these free
         └─ step 1                     SPAN
            ├─ chat gpt-5.4-mini       GENERATION  ×2 (2.12s + 2.50s) + native TTFT column
            └─ lookup_order            TOOL
```

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
  index.ts          thin: resolve config, report it, listen. Binds 0.0.0.0, no run-guard.
  config.ts         Zod env → capability flags. NEVER THROWS. The one place env is read.
  logging.ts        the ONE pino instance (+ LogLayer view). Children inherit PII scrubbing.
  agent/
    types.ts        TurnInput/TurnOutput/TurnResult/TurnDeps + ports. ZERO vendor imports.
    run-turn.ts     THE core. Channel-agnostic. Read its header before editing.
    spans.ts        the production TurnSpans adapter over obs/spans.ts
    memory.ts       passthrough MemoryComposePort (TAC's real one lands at T13)
    history.ts      bounded per-conversation transcript. Caps + eviction policy in its header.
    prompt/         port.ts · langfuse.ts · defaults.ts · slots.ts
    tools/          registry.ts · catalog.ts · resolve.ts
    model/          port.ts · openai.ts  (the ONLY file importing `ai`)
  http/
    app.ts          buildApp(deps). Testable without a socket. /api/dev/emit-turn lives here.
    sse.ts          SseHub: heartbeat, drop-on-throw, transport-agnostic
    routes-obs.ts   GET /events/stream (SSE) + /events/recent
    routes-bench.ts POST /api/bench/turn. MUST NOT import TAC — that rule is the whole point.
  obs/
    instrumentation.ts  --import preload. NodeSDK + LangfuseSpanProcessor + registerTelemetry.
    spans.ts            THE span API. Read its header before touching telemetry.
    first-token.ts      TTFT. Pure, fake clock. `collect()` here is what SMS uses.
    bus.ts              never throws on the product path; scrubs payloads once, at the boundary
    pii.ts              our own scrubber. Ancestor-path cycle detection + a depth bound.
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

## Next task: T12, TAC boot for SMS

The first task that needs Twilio credentials. `registerChannel(smsChannel)`, `memoryMode: 'always'`,
`onMessageReady` returns a **string** and must never throw (TAC swallows and only logs those —
footgun #4), and our routes go onto `server.fastify` **before** `start()`.

Read plan footguns #2, #3, #4, #9 and #22 first. In particular `new SMSChannel(tac)` **throws at
construction** without `conversationConfigurationId`, and `TACConfig.fromEnv()` throws on any of five
missing variables — so both are reachable only once `config.twilio !== null`.

**Ask before running anything that places a real call or sends a real SMS** — those are billed, and
the standing convention in this repo is not to do it unprompted.

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
  declared dependency and *is* installed, so this is not vacuous. Worth re-running after T12/T13 add
  the TAC boot, when it stops being trivially true.
- **No live-call verification.** S4 proved the TAC wiring structurally with dummy credentials;
  nothing has placed a real call. Don't run a demo end-to-end without asking — real billed calls/SMS.
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
