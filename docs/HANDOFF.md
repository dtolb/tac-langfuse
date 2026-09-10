# Handoff — demo scaffold

Written 2026-09-09. Read this first, then `~/.claude/plans/i-want-to-build-reactive-muffin.md`
for the full plan and the complete footgun list (29 entries, each verified by running it).

## What this is

A clonable starting point for customer-facing Twilio demos. Beyond the baseline (UI, agent,
backend, TAC websocket service) it deliberately invests in the three things mature
implementations have and POCs don't:

- **Telemetry** — a per-turn span waterfall with time-to-first-token, so a prompt change that
  slows the LLM is a number rather than a feeling.
- **Prompt management** — versioned, labelled, editable without a redeploy, with latency
  attributed per prompt version.
- **Tools management** — which tools an agent has, and how they're described, versioned
  alongside the prompt.

All three land in **self-hosted Langfuse**. Its prompt `config` JSON is versioned with the
prompt and is Langfuse's own documented home for `tools`/`tool_choice`/model params.

## Status: T1–T6 done, all four spikes closed

```
pnpm typecheck   → 0        (TS 7.0.2, node project + web project)
pnpm test        → 81 passed, 7 files
```

| | State |
|---|---|
| S1 AI SDK 7 + Langfuse OTel | closed — see "the finding that matters" below |
| S2 Strix under Next 16 | passed — renders, survives hydration, dialog responds |
| S3 Langfuse headless init | passed — deterministic keys, no signup |
| S4 TAC wiring | passed — footgun #2 confirmed against 2.2.0 |
| T1 foundation | done — root pkg (agent) + `web/` pkg (Next), both tsconfigs |
| T2 architecture test | done — validated by deliberate violation |
| T3 config + logging | done — never throws; PII scrubbing proven through 4 logger views |
| T4 `.env.example` | done — its own test caught a real undocumented variable |
| T5 obs spine | done — bus + SSE hub, 16 frames verified (8 replay + 8 live) |
| T6 instrumentation | done — real waterfall in Langfuse, 2 turns in 1 trace |

**Not started:** T7 prompts, T8 tools, T9 `runTurn`, T10 history, T11 bench, T12–T14 TAC,
T15–T17 Docker/Traefik, T18–T20 UI + docs. There is **no agent yet** — `POST /api/turn` returns
501. There is **no TAC, no Twilio, no Docker for the app**, and the web UI is a placeholder.

## Running it

```bash
pnpm status        # what's up, what's configured, what's therefore possible. Read-only.
pnpm langfuse      # the 6-container Langfuse stack (~2.7 GB, ready in ~10s on warm volumes)
pnpm dev:all       # agent :8910 + web :3000, ctrl-c stops both cleanly
pnpm typecheck && pnpm test

node --env-file-if-exists=.env scripts/verify-model.mjs       # is the key good, do tools fire
node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-telemetry.ts
```

Langfuse UI: <http://localhost:3100> — `demo@example.com` / `changeme-at-least-8-chars`
(headless-init values from `.env`).

`.env` currently has a real `OPENAI_API_KEY` plus local Langfuse config. **No Twilio
credentials are set**, so voice and SMS are unavailable; the app boots anyway and says so.
Note the shell also exports real `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET`
from the user profile, so those three read as present.

## Locked decisions (don't relitigate)

| | Choice |
|---|---|
| Channels | Voice (ConversationRelay) + SMS, TAC **orchestrated mode** |
| Langfuse | **self-hosted per demo** — `docker-compose.langfuse.yml` in this repo |
| Frontend | **Next.js App Router** + `@gtmi/strix-react` |
| LLM | **Vercel AI SDK v7 + OpenAI**, via **`streamText`** (not `ToolLoopAgent`) |
| Layout | nested `web/package.json`; Next owns its project root |
| Agent port | **8910** — compile-time constant in `shared/ports.ts`, deliberately not an env var |
| Durable store | none. Langfuse is the record; SSE is live and ephemeral |

## The finding that matters most

**`LangfuseSpanProcessor` silently drops raw OpenTelemetry spans.** It only forwards spans
passing its `isLangfuseSpan`/`isGenAISpan` filters. A span from
`trace.getTracer(x).startActiveSpan(...)` is created correctly — an in-memory exporter sees it,
it has a real sampled trace id — and never reaches Langfuse. The first spike's waterfall showed
the model call with nothing around it.

**Always** create spans via `server/obs/spans.ts`, which wraps `@langfuse/tracing`'s
`startObservation` / `startActiveObservation`. That module exists so no call site has to
remember. Found only by checking the UI rather than trusting that the code ran clean.

Related: `trace.getTracerProvider()` returns a `ProxyTracerProvider` with **no** `forceFlush`,
so `.forceFlush?.()` is a silent no-op. Flush via `.getDelegate()` — `flushTelemetry()` does.

## Layout

```
server/
  index.ts          thin: resolve config, report it, listen. Binds 0.0.0.0, no run-guard.
  config.ts         Zod env → capability flags. NEVER THROWS. The one place env is read.
  logging.ts        the ONE pino instance (+ LogLayer view). Children inherit PII scrubbing.
  http/
    app.ts          buildApp(deps) — everything mounted. Testable without a socket.
    types.ts        the `App` type (must be spelled out; see the comment in there)
    sse.ts          SseHub: heartbeat, drop-on-throw, transport-agnostic
    routes-obs.ts   GET /events/stream (SSE) + /events/recent
  obs/
    instrumentation.ts  --import preload. NodeSDK + LangfuseSpanProcessor + registerTelemetry.
    spans.ts            THE span API. Read its header before touching telemetry.
    first-token.ts      TTFT. Pure, 10 tests, fake clock.
    bus.ts              never throws on the product path; scrubs payloads once, at the boundary
    pii.ts              our own scrubber (copied from TAC deliberately — see the header)
shared/               types + pure constants ONLY. Compiled by BOTH tsconfigs.
web/                  Next 16 + Strix. Own package.json, own lockfile, own .npmrc.
tests/                vitest. No mocking library, no snapshots — injection instead.
scripts/              status.mjs, dev.mjs, verify-model.mjs, verify-telemetry.ts
```

## Next task: T7, the prompt subsystem

Everything below T6 is unblocked and Langfuse is already running with a project provisioned.

1. `server/agent/prompt/port.ts` — `PromptPort` + `ResolvedPrompt` + `PromptConfigSchema`
   (`.strict()`, so a typo'd config key surfaces). Fields: `model`, `temperature`,
   `maxOutputTokens`, `tools: string[]` (**names only, never schemas**), `toolChoice`, `maxSteps`.
2. `server/agent/prompt/langfuse.ts` — the ONLY file allowed to import `@langfuse/client`
   (enforced by `tests/architecture.test.ts`). Fetch by **label** (`production`), not version.
3. `server/agent/prompt/defaults.ts` — `DEFAULT_PROMPTS` compiled in. Non-negotiable: Langfuse
   is 6 containers and this gets demoed live. On any failure return the default with
   `version: 'fallback'` and surface that string in the console where a version would go.
4. `server/agent/prompt/slots.ts` — `{{var}}` substitution against a **tested allowlist**. An
   unknown placeholder must render VISIBLY, so a typo is obvious on turn 1 rather than quietly
   producing a worse agent.
5. `scripts/seed-prompts.ts` — push defaults as version 1 with the `production` label.

**Verified API shapes** (from spike S1, working against this exact Langfuse):

```ts
await langfuse.prompt.create({ name, type: 'chat', prompt: [{role, content}], config, labels: ['production'] })
const p = await langfuse.prompt.get(name, { label: 'production' })
p.version   // 1
p.config    // round-trips exactly, including tools: ['search_knowledge', 'send_message']
p.compile({ persona: 'a support agent' })   // → [{role, content}]
p.toJSON()  // pass as experimental_telemetry.metadata.langfusePrompt to link trace→version
```

Done when: seeding creates v1 + `production`; `docker compose -f docker-compose.langfuse.yml
stop langfuse-web` still yields a turn with `version: 'fallback'`.

## Gaps and honest limits

- **PII does reach Langfuse.** Our own spans are scrubbed (verified: `+1***4567`), but the AI
  SDK's model spans (`invoke_agent`, `chat <model>`) are built by the Langfuse integration and
  carry the full prompt and completion. That is largely the point of tracing, and the stack is
  self-hosted per demo — but do not describe this app as keeping PII out of Langfuse.
- **t0 is our first observation, not STT arrival.** Un-measurable upstream: WS frame parse,
  `startStreamTask`, and TAC's `promptQueues` serialisation (`voice.ts:630`) where a slow
  previous turn delays the next transcript. Plan records `turn.gap_ms` and documents what it
  conflates rather than inventing a precise-looking number.
- **Langfuse v4 `events_only` mode has no public read API for traces.** `/api/public/traces`,
  `/observations`, `/metrics/daily` all 404; `/events` and `/spans` are POST-only. Prompts read
  fine via `/api/public/v2/prompts`. This *validates* keeping our own SSE ring buffer — but it
  means trace verification is a **UI check via Playwright MCP**, never an API assertion.
- **No live-call verification yet.** S4 proved the TAC wiring structurally with dummy
  credentials; nothing has placed a real call. Per standing convention, don't run a demo
  end-to-end without asking — it places real billed calls and SMS.
- `docker-compose.yml` for the app itself does not exist yet (T15). The Langfuse compose does.
- `web/README.md` is still Next's boilerplate; T20 replaces it.

## Conventions worth not breaking

- **Boot never hard-fails.** Empty env → loud per-variable warnings, `/health` 200, 503 naming
  the variable. `TACConfig.fromEnv()` throws, so only call it once `config.twilio !== null`.
- **`shared/` is data.** Compiled by both projects, so no Node global and no DOM global. Needs
  `allowImportingTsExtensions` in `web/tsconfig.json` (verified: Turbopack resolves `.ts` fine).
- **Vendor boundaries are tested.** Only `server/twilio/` may import TAC; only
  `agent/model/openai.ts` may import `ai` (plus `obs/instrumentation.ts` for `registerTelemetry`
  ONLY, itself asserted); only `agent/prompt/langfuse.ts` may import `@langfuse/client`. Prove a
  guard bites before trusting it — I broke each one deliberately.
- **No `console.*`** anywhere under `server/` or `web/src/` — it bypasses the PII scrubber.
- **Never** add tsconfig `paths` for `@gtmi/strix-react/*`, `transpilePackages`, or your own
  `@source`. All three are 0.0.1-era workarounds that now cause harm; the first makes every
  import `undefined` at runtime.
- Strix has **no** Table, Chart, Drawer, Accordion, Popover or EmptyState, and Toast/Alert have
  no queue or provider. The authoritative list is the `exports` map in the package's
  `package.json` — `llms.txt` is stale. Per-component props are in the shipped
  `*.manifest.json` files (`props` is an **array** of `{name, type, required, ...}`).
