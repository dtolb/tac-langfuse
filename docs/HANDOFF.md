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

## Status: T1–T9 done, all four spikes closed

```
pnpm typecheck   → 0          (TS 7.0.2, node project + web project)
pnpm test        → 184 passed, 10 files
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

**Not started:** T10 history, T11 bench, T12–T14 TAC, T15–T17 Docker/Traefik, T18–T20 UI + docs.

There is a **working agent core** but **no way for a human to talk to it yet** — `POST /api/turn`
still returns 501 and there is no bench page. That is T11, two tasks away. There is no TAC, no
Twilio, no Docker for the app, and the web UI is a placeholder.

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

`verify-turn.ts` is the one that matters most now: it drives a **real** turn — live Langfuse prompt,
real catalog, real model — and prints the version, tools called, TTFT and totals. It exits non-zero
on a surprise, so it doubles as a smoke check.

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
    prompt/         port.ts · langfuse.ts · defaults.ts · slots.ts
    tools/          registry.ts · catalog.ts · resolve.ts
    model/          port.ts · openai.ts  (the ONLY file importing `ai`)
  http/
    app.ts          buildApp(deps). Testable without a socket. /api/dev/emit-turn lives here.
    sse.ts          SseHub: heartbeat, drop-on-throw, transport-agnostic
    routes-obs.ts   GET /events/stream (SSE) + /events/recent
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

## Next task: T10, conversation history

Small, well-bounded, and the last thing between here and a human talking to the agent.

**Why it exists:** TAC hands you only the current message. History is in-process and never exposed
(plan footgun #6). Without our own store we ship an amnesiac agent that passes every test.

1. `server/agent/history.ts` — a bounded `Map<conversationId, TurnMessage[]>`. Use
   **`TurnMessage`** from `server/agent/types.ts`, **not** the AI SDK's `ModelMessage`: the plan
   sketches `ModelMessage[]`, but that type comes from `ai`, which
   `tests/architecture.test.ts` confines to `server/agent/model/`. Same deviation, same reason, as
   T9 already documents.
2. Cap it two ways — messages per conversation, and conversations in the map. A demo box that runs
   for a week must not grow without bound. Decide and document the eviction policy.
3. Clear explicitly on `conversationEnded` / `webSocketDisconnected` (T13 calls it; just export it).
4. Add a `history` port to `TurnDeps` and wire it into `run-turn.ts`: read before the model call,
   append the user message and the final assistant text after. Appending the assistant turn belongs
   inside `done`, since that is where the final text exists.
5. Decide what happens on an aborted turn — a barge-in leaves partial text. Whether that partial
   answer belongs in history is a real product decision; make it deliberately and write down why.

**Done when:** turn 2 sees turn 1, a cleared conversation does not, the caps evict as documented, and
`scripts/verify-turn.ts` (extended to a second turn) shows the model actually referring back.

Verify by running two turns, not by reading the code.

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
