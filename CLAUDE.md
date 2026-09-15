# Working in this repo

A **Twilio demo scaffold**: one AI agent reachable by voice, SMS and a browser, with versioned
prompts, versioned tool selection, and per-turn tracing. Node 24 runs the TypeScript directly —
**there is no build step** for the agent.

`README.md` is the front door for a human cloning it. This file is the part you need before changing
anything.

## Read first

- **`docs/HANDOFF.md` is authoritative for state and is where new verified findings go** — not memory,
  not this file. It records what was built and *measured* task by task, the places reality contradicted
  the plan, and a "Gaps and honest limits" section. It is long because most of it cost real time to
  discover once.
- `.env.example` is the configuration documentation. Every entry says what breaks when it is absent.
- `web/` has its own `CLAUDE.md` → `AGENTS.md`, written by `next dev`. **This Next version has breaking
  changes from training data** — read `web/node_modules/next/dist/docs/` before writing Next code.

## Enforced by tests — these fail the suite, they are not style

- **`twilio-agent-connect` and `twilio` may only be imported from `server/twilio/` or `scripts/`.**
  This is what keeps the agent core channel-agnostic and makes the Twilio-free bench a *runtime* proof
  rather than a claim about import strings.
- **`ai` and `@ai-sdk/openai` only from `server/agent/model/`** (plus `instrumentation.ts` for
  `registerTelemetry` alone); **`@langfuse/client` only from `server/agent/prompt/`.**
- **No `console.*` in `server/` or `web/src/`.** Everything goes through the one logger carrying the
  PII-scrubbing hook. `scripts/` is exempt.
- **`shared/` must import nothing outside `shared/`** and must touch no Node or DOM global — both
  tsconfig projects compile it.
- **Every `process.env.VAR` read in `server/` or `scripts/` must appear in `.env.example`**, including
  in `.mjs` files.
- **`docker-compose.yml` must keep that exact name**, list every prefix from `shared/twilio-paths.ts`
  as a literal `` PathPrefix(`…`) ``, and use the label **list** form with a literal `=`.

Several tests are *tripwires* asserting the rule sets themselves are intact. The failure mode of a
guard is not a false alarm — it is passing silently forever, so do not "simplify" one away.

## Commands, and the four that bite

```bash
pnpm dev:all       # agent :8910 + web :3000
pnpm stack:up      # containers: preflight, then compose up -d --build
pnpm stack:down
pnpm status        # host processes, containers, capabilities, URLs. Read-only
pnpm typecheck && pnpm test
```

1. **`pnpm test -- <file>` does NOT filter** — it silently runs the whole suite. Use
   `pnpm vitest run <file>`.
2. **`pnpm up` is pnpm's built-in alias for `pnpm update`** and a script cannot shadow a builtin. The
   script is `pnpm stack:up`.
3. **Never hand-author `package.json`** — use `pnpm pkg set`. A script name containing a colon needs
   the bracket form: `pnpm pkg set 'scripts["seed:studio"]=…'`.
4. **`pnpm dev:all` runs the agent under `--watch`**, so killing the `:8910` listener respawns it — kill
   `scripts/dev.mjs`, the supervisor. Use `lsof -ti :8910 -sTCP:LISTEN`; without `-sTCP:LISTEN` the list
   includes any open tunnel.

**RESTART THE AGENT AFTER A CODE CHANGE BEFORE CONCLUDING A FIX DOESN'T WORK.** Node does not
hot-reload. Check `ps -p <pid> -o lstart=` against the commit time first — this has burned a whole
debugging session. Langfuse *prompt* edits do land live (~20s TTL); code does not.

**Containers: after any `.env` change use `docker compose up -d --force-recreate`, never `restart`** —
`restart` re-runs the container with its original env block, so the change silently does not take.

**The stack runs `restart: "no"` on purpose — it must NOT come back after a reboot,** because it
publishes unauthenticated endpoints on a stable public host. Langfuse is `always` and does return, so
tooling survives a restart while the demo surface needs an explicit `pnpm stack:up`. Do not "fix" this
to `unless-stopped`. `on-failure` is also wrong: it restarts a non-zero exit, and on a VM stop the agent
exits 0 while Next exits 143, so it resurrects half the stack.

## How to write code here

- **Comments explain WHY, at length, and cite what was measured.** This repo is a teaching artifact.
  But **a confidently wrong comment is worse than none** — a review found eight assertive comments
  describing behaviour the adjacent code did not have. Check the claim before you write it, and
  **cite the symbol, not the line number**, so it cannot rot.
- **A claim inherited from an approved plan is still a claim.** Approval means the approach is agreed,
  not that every factual assertion in it was verified.
- **Tests: integration over unit.** Don't coverage-chase — this is a demo scaffold, not production.
  Prefer one test that drives a real socket over many that assert on mocks.
- **Report environment hazards, don't police them in code.** Warn; don't add speculative guards.
- **Work WITH TAC, not around it.** Never add code or scripts to avoid loading
  `twilio-agent-connect`; extend it or supply what it omits.
- **Match the surrounding comment density and idiom.** New files here are heavily commented by design.

## Twilio

Use **`twil`** and the `/twilio:twilio` skill — the official `twilio` CLI is uninstalled. See the
global `~/.claude/CLAUDE.md` for the full rules, including that mutations need a backup first.

- **Billed traffic is pre-authorized** — real calls and SMS need no confirmation. Mutations still need
  a backup.
- **`TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY` / `TWILIO_API_SECRET` come from the shell profile, not
  `.env`**, so they read as present regardless of `.env`, and a container gets them only via explicit
  passthrough. An agent started from a different shell will 503.
- **A public HTTPS host is required for inbound**, and **three places must agree**:
  `TWILIO_VOICE_PUBLIC_DOMAIN`, the number's `voice_url`, and the CO configuration's
  `statusCallbacks[0].url`. `scripts/repoint-public-host.ts <host> --write` moves all three.
  **Repoint BEFORE starting the stack** — backwards, everything reports healthy and every call sits in
  silence with nothing in the logs, because the WebSocket never arrives.
- **`twil webhook invoke --type voice --auth-token <token> https://<host>/twiml`** is a free signed
  pre-flight and the single most useful check before spending anything.
- **Testing SMS from a second number on the same account doubles every reply.** Both message legs
  share `from`/`to`, so the capture rule matches each. Not a bug — use an external handset to measure
  reply count.

## Diagnostics before guessing

The `scripts/verify-*` diagnostics answer questions you cannot answer by reading code — model
reachability, live prompts vs the fallback, tool resolution, whether a span really reaches Langfuse,
memory extraction, knowledge retrieval, and three real turns end to end. Each one's header says what
it proves; read that rather than inferring from the filename. `GET /events/stream` is a
live SSE feed of every turn, and its `webhook.inbound` event publishes **the exact URL Twilio's
signature was validated against**.

**Langfuse here is v4 in `events_only` mode, so its read API is DISABLED** — `GET /api/public/traces`
returns 404 meaning *disabled*, not *no data*. Verify traces in ClickHouse `events_core`, or the UI.

**Latency: read `attributes.gen_ai.client.operation.time_to_first_chunk` before theorising.** It is a
native AI SDK attribute on every `GENERATION` in `events_full`, **in seconds**, and it accounts for the
generation span almost exactly — so "is it us or is it the model?" is one query, not an investigation.
Measured 2026-09-15 across 33 generations: the framework costs **84 ms**, and everything else is model
time-to-first-chunk. Two things follow, both of which will mislead you otherwise:

- **The memory block is now 52% of the system prompt and grows per call** (2341 → 4412 chars in a day;
  `memory-compose.ts` caps nothing). It is absorbed by the prompt cache on turns 2+, so it costs almost
  entirely the **first turn of each conversation** — which is the turn a caller judges.
- **The T15 close-out call (17:56 UTC) landed in a 2–5× upstream slow window** and its 6.0–7.7 s TTFTs
  are the worst on record. **Never quote it as a latency baseline.** Confirm any "it got slower" against
  a tool-free turn, which is 586–801 ms when the model is healthy.

Full waterfall, the per-component prompt budget, and the four ranked levers are in `docs/HANDOFF.md`
→ "Latency, investigated 2026-09-15". Note `search_knowledge`'s long description is load-bearing (T14),
so it is not free to trim.

**A voice trace is now TILED, so read the timeline before asking where the time went.** `turn.voice`
spans `prompt` receipt → `last: true` sent, `caller.turn` covers every instant between two turns, and the
two alternate with **0 ms between them** on a real call (measured 2026-09-15: 42.7 s root fully covered,
against 45.3 s of unexplained gap the day before). Three traps:

- **`caller.turn` is a BLEND — bot playback + caller speech + ASR endpointing**, plus TAC's memory Recall
  on turn 1. It was 65% of a real call. Never quote it as "how long the caller talked".
- **`turn.ttfa_ms` is a server-side proxy and lands within 0–3 ms of `turn.ttft_ms`.** TAC `ws.send`s each
  token synchronously, so it proves nothing queues between model and socket — and it cannot see TTS or
  playback, which is the part a caller hears. Do not present it as time-to-first-audio.
- **The interrupt handler PARKS the boundary; the prompt handler's `finally` closes the span.** Closing it
  in the interrupt handler costs a barged-in turn its `output` / `tools.called` / `turn.total_model_ms`,
  because `runTurn` writes those after `await done`. Do not "simplify" it.

Details, the four review fixes and the honest limits: `docs/HANDOFF.md` → "Voice latency TIMELINE".
