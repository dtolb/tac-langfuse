# Architecture and capabilities

The detail behind the diagram in [`README.md`](README.md): what the moving parts are, what each
capability costs when it is missing, where the code lives, and which rules are enforced by tests rather
than convention.

[DEPLOY.md](DEPLOY.md) is the operator's guide. This file is the map.

- [The request path](#the-request-path)
- [Capabilities, and what each one costs](#capabilities-and-what-each-one-costs)
- [It never dies at boot](#it-never-dies-at-boot)
- [Source layout](#source-layout)
- [Proof, not claims](#proof-not-claims)
- [What a trace looks like](#what-a-trace-looks-like)

---

## The request path

Three channels, one agent. The difference between them is entirely in the adapter.

**Voice.** Twilio hits `/twiml`, which returns a `<ConversationRelay>` pointing at `wss://<host>/ws`.
Twilio opens that socket and streams recognised speech in as `prompt` messages; the agent streams tokens
back out, and Twilio does TTS and playback. Barge-in arrives as an interrupt on the same socket. The
call ends either because the caller hangs up or because the agent calls `end_call`.

**SMS.** Conversation Orchestrator captures the inbound message and posts to the agent's webhook. The
same `runTurn` produces the reply. No socket, no streaming — the adapter simply waits for the complete
answer.

**Browser.** `/api/bench/turn` streams a turn over plain HTTP to `/bench`. No Twilio anything.

All three converge on **one function**: resolve the prompt (Langfuse, or the compiled-in fallback) →
resolve the tool list for that prompt version → call the model → execute any tools → stream the result.
Whatever is channel-specific — how audio arrives, how a reply is delivered, how a call is ended — lives
in an adapter under `server/twilio/`, and the core cannot import it.

The **handoff** path is the one that crosses back out: the `handoff` tool snapshots the transcript and
the stated reason, the voice-action callback redirects the live call into a Studio flow, and that flow
rings the browser softphone with a screen pop carrying the snapshot. The human sees why the caller asked
for a person before saying hello.

## Capabilities, and what each one costs

Every capability is independent, resolved once at boot in `server/config.ts`, and reported by
`GET /health`. Nothing throws.

| Capability | Needs | What its absence costs |
|---|---|---|
| `llm` | `OPENAI_API_KEY` | Nothing works. This is the one that matters |
| `prompts` | Langfuse keys + host | Prompts fall back to compiled-in defaults and report their version as `fallback`. Editing behaviour needs a redeploy again |
| `voice` | All five Twilio variables + a public host | `/twiml` and `/ws` return 503. Everything else is unaffected |
| `sms` | All five Twilio variables + an Orchestrator configuration | The SMS webhook returns 503 |
| `memory` | Twilio Memory store id | The agent stops recognising callers between conversations; `retrieve_profile_memory` disappears |
| `knowledge` | Knowledge Base id | `search_knowledge` is simply absent from the tool list, and the model stops being asked to use it |
| `handoff` | Studio flow SID + a softphone identity | The `handoff` tool disappears; the agent says it cannot transfer |

The full version of this table, with the exact failure mode of each variable, is
[`.env.example`](.env.example) — which is committed, is the documentation, and is tested against the code.
A variable the code reads but the file does not describe fails `pnpm test`.

## It never dies at boot

Start it with an empty `.env` and it comes up. Each missing variable produces one warning naming **what
that variable costs you**, `/health` returns 200 with a capability map, and only the routes that
genuinely cannot work return 503.

```jsonc
GET /health → { "capabilities": { "llm": true, "prompts": true, "voice": true,
                                  "sms": true, "memory": true, "handoff": true,
                                  "knowledge": true },
                "missing": [] }
```

This is deliberate, and it is the opposite of what a production service should do. A demo that refuses to
boot is undebuggable at the worst possible moment — in front of someone, on a machine that is not yours,
with a `.env` you copied five minutes ago. Loud degradation means the failure is *legible*: `pnpm status`
and `/health` both name the missing variable and the capability it costs, so the answer to "why is it not
answering the phone" is on screen rather than in a stack trace.

## Source layout

```
server/
  index.ts          boot: resolve config, degrade loudly, listen
  config.ts         every env var → a capability. Never throws
  http/             Fastify app, bench routes, SSE, voice-action, handoff
  agent/            the channel-agnostic core
    run-turn.ts       one turn: prompt + memory → model → tools → stream
    model/            the LLM provider, swappable in one file
    prompt/           Langfuse prompts behind a port, with compiled-in fallback
    tools/            registry, catalog, three-way resolver
  twilio/           the ONLY place the Twilio SDK and TAC may be imported
  handoff/          the transcript snapshot the human agent sees before saying hello
  obs/              bus, SSE hub, spans, PII scrubbing
shared/             constants both sides must agree on. Self-contained, no globals
web/                Next app: bench, softphone. Its own install root
scripts/            seeds and diagnostics
tests/              integration-weighted, plus tripwires on the guards
```

Three pages: `/` (landing), `/bench` (drive a turn with no credentials), `/softphone` (where a handed-off
caller lands — open it *before* the call, or the transfer rings nothing).

The six tools are tabulated in [README.md](README.md#tools). Their definitions live in
`server/agent/tools/catalog.ts`, except `search_knowledge` and `retrieve_profile_memory`, which are built
from a live TAC handle in `server/twilio/builtin-tools.ts` — so they are absent from the process-wide
catalog *by construction* and present only in the augmented one `bootTac` builds. That distinction is why
the tool preflight logs them at debug rather than as errors: reporting them on every bare-laptop run
would train you to ignore the line that does matter, a genuine typo in a checked-in prompt.

## Proof, not claims

Five rules are enforced by tests, not convention, because every one of them fails **silently** when
broken — the code keeps working and the property you cared about is quietly gone.

| Rule | Why a test and not a review |
|---|---|
| `twilio-agent-connect` and the `twilio` SDK only from `server/twilio/` (or `scripts/`) | This is what makes the credential-free bench a *runtime* proof that the core is channel-agnostic, rather than a claim about import strings |
| `ai` and `@ai-sdk/openai` only from `server/agent/model/` | Keeps the provider swappable in one file |
| `@langfuse/client` only from `server/agent/prompt/` | Keeps prompt management behind its port |
| No `console.*` in `server/` or `web/src/` | One logger carries the PII-scrubbing hook. `console.*` bypasses it and nothing complains |
| `shared/` imports nothing outside `shared/` and touches no Node or DOM global | Both tsconfig projects compile it, so a stray global breaks the other side later |

Plus: every `process.env` read in `server/` or `scripts/` must appear in `.env.example`, and the compose
file's routing labels are asserted against `shared/twilio-paths.ts` — so adding a route and forgetting to
route it fails the suite instead of producing a 404 that looks like a Twilio problem.

Several tests are **tripwires** that assert the rule sets themselves are intact. The failure mode of a
guard is not a false alarm; it is passing silently forever. Do not "simplify" one away.

```bash
pnpm typecheck && pnpm test      # 350 tests, 20 files
```

Tests here are integration-weighted on purpose — one test that drives a real socket beats many that
assert on mocks. This is a demo scaffold, so there is no coverage target.

Seven `scripts/verify-*` diagnostics cover what tests cannot: whether the configured model is reachable,
whether the live prompts differ from the fallback, whether the catalog resolves what Langfuse serves,
whether a span from this process really lands in Langfuse, whether memory extraction has ever produced
anything, whether the knowledge base answers real questions, and three real turns end to end. See
[DEPLOY.md](DEPLOY.md#verify-before-you-spend-anything).

## What a trace looks like

Every turn is one Langfuse trace with the prompt fetch, tool selection, the model generation, each tool
execution and first-token latency as spans. The same events stream live over
`GET /events/stream` — `turn.start`, `prompt.fetch`, `tool.selection`, `llm.first_token`, each
`tool.execution`, `llm.response`, `turn.end` — plus a `webhook.inbound` diagnostic that publishes **the
exact URL Twilio's signature was validated against**, which is the fastest way to tell "Twilio isn't
calling us" from "our URL doesn't match what Twilio signed".

A voice trace is **tiled**: `turn.voice` spans prompt-received → last-token-sent, `caller.turn` covers
every instant between two turns, and on a real call the two alternate with 0 ms between them, so the root
span is fully accounted for. Three things about it mislead if you don't know them:

- **`caller.turn` is a blend** — bot playback, caller speech and ASR endpointing, plus Memory recall on
  turn 1. It was 65% of a real call. It is not "how long the caller talked".
- **`turn.ttfa_ms` is a server-side proxy** that lands within 0–3 ms of `turn.ttft_ms`. It proves nothing
  queues between the model and the socket; it cannot see TTS or playback, which is the part a caller hears.
- **Latency questions are one attribute, not an investigation.**
  `gen_ai.client.operation.time_to_first_chunk` is native to the AI SDK, in seconds, and accounts for the
  generation span almost exactly. Measured across 33 generations: the framework costs 84 ms.

One known cost worth watching: the memory block is roughly half the system prompt and grows per call.
The prompt cache absorbs it from turn 2 onward, so it is paid on the **first turn of each conversation** —
which is the turn a caller judges.

The full waterfall, the per-component prompt budget and the ranked levers are in
[`docs/HANDOFF.md`](docs/HANDOFF.md) → "Latency, investigated 2026-09-15" and "Voice latency TIMELINE".
