# Twilio demo scaffold

A clonable starting point for customer-facing Twilio demos: **one AI agent, reachable by voice, SMS
and a browser**, with the parts that usually get rebuilt from scratch already wired up and proven
against real traffic.

The agent answers a phone call, answers a text, remembers the caller between conversations, searches a
knowledge base, and hands the call to a human when asked. Every turn is traced, every prompt is
versioned outside the code, and there is a browser bench that drives the whole agent with no Twilio
credentials at all.

> **This is a demo scaffold, not a production service.** It is deliberately built for the "art of the
> possible" conversation — it degrades loudly rather than failing safely, several endpoints are
> unauthenticated, and it assumes one process holds conversation state in memory. Those are
> choices, and `docs/HANDOFF.md` names each one.

---

## What it can do

| | |
|---|---|
| **Voice** | Inbound calls over ConversationRelay — streaming STT/TTS, barge-in on real audio, and the agent can hang up by itself |
| **SMS** | Inbound texts through Conversation Orchestrator, answered by the same agent code |
| **Memory** | Conversation Memory across *separate* conversations — a caller's fact from last week comes back with zero tool calls |
| **Knowledge** | `search_knowledge` against a real Twilio Knowledge Base, on both channels |
| **Human handoff** | The caller asks for a person; the call transfers to a browser softphone with a screen pop showing the reason and the transcript so far |
| **Observability** | Every turn is a Langfuse trace — prompt fetch, tool selection, model call, each tool, first-token latency |
| **Versioned prompts** | Prompts and their model + tool list live in Langfuse, so changing behaviour is a prompt revision rather than a redeploy. Falls back to compiled-in defaults when Langfuse is down |
| **A Twilio-free bench** | `/bench` streams a complete agent turn in a browser with no Twilio credentials — which is also the runtime proof that the agent core is channel-agnostic |

The agent ships six tools: `lookup_order`, `get_store_hours`, `end_call`, `retrieve_profile_memory`,
`search_knowledge`, `handoff`. The first two are credential-free fakes so the demo works before any
Twilio setup exists.

### It never dies at boot

Start it with an empty `.env` and it comes up. Every missing variable produces one warning naming
**what that variable costs you**, `/health` returns 200 with a capability map, and only the routes that
genuinely cannot work return 503. This is deliberate: a demo that won't boot is undebuggable at the
worst possible moment.

```
GET /health → { "capabilities": { "llm": true, "prompts": true, "voice": true,
                                  "sms": true, "memory": true, "handoff": true,
                                  "knowledge": true },
                "missing": [] }
```

Every capability above is independent. No Twilio account? The bench and the traces still work. No
Langfuse? Prompts fall back and report their version as `fallback`. No knowledge base? That one tool
is simply absent.

---

## Getting started

**Requirements:** Node 24+ (it runs the TypeScript directly — there is no build step), pnpm 11, and
Docker only if you want the Langfuse stack or the containers.

```bash
pnpm install
cp .env.example .env        # then read it — it documents what each variable costs
pnpm langfuse               # optional: the 6-container Langfuse stack, ready in ~10s on warm volumes
pnpm dev:all                # agent + web, ctrl-c stops both
pnpm status                 # what's running, what's configured, what's therefore possible
```

`.env.example` is the real configuration documentation and is worth reading top to bottom. It is
committed, tested against the code (a variable the code reads but the file doesn't document fails
`pnpm test`), and every entry says what breaks when it's absent rather than just what it is.

The minimum for a useful demo is `OPENAI_API_KEY`. Everything else unlocks a capability.

### Three pages

| | |
|---|---|
| `/` | Landing page (placeholder) |
| `/bench` | Drive a full agent turn from the browser, streaming, no Twilio needed |
| `/softphone` | Where a caller **lands** when the agent hands them to a human. Open it *before* the call, or the transfer rings nothing |

---

## Running it

Two modes. They are interchangeable for development but **mutually exclusive for Twilio traffic**,
because `TWILIO_VOICE_PUBLIC_DOMAIN` names exactly one public host — whichever mode isn't named
receives nothing.

### Host processes

```bash
pnpm dev:all      # agent on :8910, Next on :3000
```

Next proxies `/api`, `/events` and `/health` to the agent in dev, so browser code fetches **relative**
paths and is identical in both modes.

⚠ The agent runs under `--watch`, so killing the listener on `:8910` just respawns it — kill
`scripts/dev.mjs`, the supervisor. And use `lsof -ti :8910 -sTCP:LISTEN`; without `-sTCP:LISTEN` the
list includes any tunnel you have open and you take that down too.

### Containers

```bash
pnpm stack:up     # preflight, then docker compose up -d --build
pnpm stack:down
```

**The stack does not come back by itself after a reboot**, by design: it runs `restart: "no"`, so
starting the public surface is always an explicit act. The Langfuse stack *is* `always` and does return
on its own, so your tooling survives a restart while the demo does not sit exposed unattended.

⚠ **Not `pnpm up`** — `up` is a built-in alias for `pnpm update`, and a package.json script cannot
shadow a built-in, so it would rewrite the pinned lockfile and start nothing.

Two images: the agent (no build step, Node runs the TypeScript) and Next in `standalone` mode. Both
build from the **repo root**, because `web/` imports `../shared/*.ts`.

`pnpm preflight` runs first and refuses to bring the stack up on a misconfiguration that Docker,
the proxy and the app would all otherwise accept in silence — a default or malformed `APP_NAME`, a
missing container network, an unresolvable CA path, or an `APP_NAME` exported in your shell that
disagrees with `.env`.

**After any `.env` change: `docker compose up -d --force-recreate`, never `restart`.** `restart`
re-runs the existing container with its *original* env block, so the change silently does not take.

### Twilio needs a public HTTPS host

Inbound calls and texts require a public URL, and the same value builds both the media WebSocket
(`wss://<host>/ws`) and the call-action callback. How you provide it is up to your environment — a
tunnel, a reverse proxy, or a hosted URL.

Whatever you use, **three places must agree**: `TWILIO_VOICE_PUBLIC_DOMAIN` in `.env`, the phone
number's `voice_url`, and the Conversation Orchestrator configuration's `statusCallbacks[0].url`.
One command moves all three, backing the configuration up and re-reading the backup before the
full-replace PUT:

```bash
node --env-file-if-exists=.env scripts/repoint-public-host.ts <bare-host>          # dry run
node --env-file-if-exists=.env scripts/repoint-public-host.ts <bare-host> --write
```

⚠ **Repoint BEFORE you start the stack, never after.** Backwards is the most demo-destroying mistake
available here: the process boots green, `/health` reports `voice: ready`, routing works, and every
call connects to the old host and sits in **silence with nothing in the logs**, because the WebSocket
never arrives. `pnpm preflight` and `pnpm status` both warn when the host looks wrong.

If the agent and the web app are served on one public host, whatever sits in front must send
`/webhook`, `/twiml`, `/ws`, `/conversation-relay-callback`, `/twilio/call-events`, `/api`, `/events`
and `/health` to the **agent**, and everything else to **Next**. That list is
`shared/twilio-paths.ts`, and a test asserts the routing config against it so adding a route and
forgetting to route it fails the suite instead of producing a 404 that looks like a Twilio problem.

---

## Setting up the Twilio side

Scripts, not console clicking. Each prints what it created so you can paste the id into `.env`.

```bash
pnpm seed:prompts               # push the compiled-in prompts to Langfuse as v1 + `production`
pnpm seed:prompts <name>        # just one — every run relabels what it touches, so prefer this
pnpm seed:knowledge             # create a Knowledge Base, push the demo articles, print the id
pnpm seed:studio                # publish the Studio flow that rings the browser softphone
```

---

## Proving it works

Seven diagnostics, each answering a question you cannot answer by reading code. They are cheap, and
none of them needs a phone call.

```bash
pnpm verify:turn                                     # three real turns of one conversation, end to end
node --env-file-if-exists=.env scripts/verify-model.mjs     # is the configured model actually reachable
node --env-file-if-exists=.env scripts/verify-prompts.ts    # live versions AND the fallback path
node --env-file-if-exists=.env scripts/verify-tools.ts      # does the catalog resolve what Langfuse serves
node --env-file-if-exists=.env scripts/verify-telemetry.ts  # does a span from THIS process reach Langfuse
node --env-file-if-exists=.env scripts/verify-memory.ts     # is memory on, has extraction ever produced anything
node --env-file-if-exists=.env scripts/verify-knowledge.ts  # does the KB answer what the tools cannot
```

Before spending anything on real traffic, send yourself a **signed, simulated** Twilio webhook — this
is the single most useful free check in the repo, because it exercises signature validation over the
real public path:

```bash
twil webhook invoke --type voice --auth-token <TWILIO_AUTH_TOKEN> https://<host>/twiml
```

A 200 plus TwiML naming your host in both `wss://…/ws` and `action=…` means voice will work.

```bash
pnpm typecheck && pnpm test      # 327 tests, 19 files
```

The tests are integration-weighted on purpose. Several are *tripwires* that assert the rule sets
themselves are intact, because the failure mode of a guard is not a false alarm — it is passing
silently forever.

### Watching a turn happen

`GET /events/stream` is a Server-Sent Events feed of every turn: `turn.start`, `prompt.fetch`,
`tool.selection`, `llm.first_token`, each `tool.execution`, `llm.response`, `turn.end`, plus a
`webhook.inbound` diagnostic that publishes **the exact URL Twilio's signature was validated
against** — which is the fastest way to tell "Twilio isn't calling us" from "our URL doesn't match
what Twilio signed".

---

## How it's put together

```
server/
  index.ts          boot: resolve config, degrade loudly, listen
  config.ts         every env var → a capability. Never throws
  http/             Fastify app, bench routes, SSE, voice-action, handoff
  agent/            the channel-agnostic core
    run-turn.ts       one turn: prompt + memory → model → tools → stream
    model/            the LLM provider, swappable in one file
    prompt/          Langfuse prompts behind a port, with compiled-in fallback
    tools/            registry, catalog, three-way resolver
  twilio/           the ONLY place the Twilio SDK and TAC may be imported
  handoff/          the transcript snapshot the human agent sees before saying hello
  obs/              bus, SSE hub, spans, PII scrubbing
shared/             constants both sides must agree on. Self-contained, no globals
web/                Next app: bench, softphone. Its own install root
scripts/            seeds and diagnostics
tests/              integration-weighted, plus tripwires on the guards
```

Two boundaries are enforced by tests rather than convention, because both fail silently when broken:

- **The Twilio SDK and TAC may only be imported from `server/twilio/`.** That is what keeps the agent
  core channel-agnostic, and it's what makes the Twilio-free bench a *runtime proof* rather than a
  claim about import strings.
- **No `console.*` in `server/` or `web/src/`.** Every log line goes through the one logger that
  carries the PII-scrubbing hook; `console.*` bypasses it silently.

---

## Where to look next

**`docs/HANDOFF.md`** is the deep record and the place to start before changing anything. It carries
what was built and *measured* task by task, the corrections where reality contradicted the plan, and
an explicit "Gaps and honest limits" section — including the unauthenticated endpoints, the in-memory
conversation state, and what the bench does *not* prove.

It is long, and that is the point: most of it is findings that cost real time to discover once.
