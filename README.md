<div align="center">

<img src="docs/assets/logo.svg" alt="tac-langfuse" width="480">

**One AI agent, reachable by voice, SMS and a browser — with versioned prompts,
versioned tool selection, and every turn traced.**

[![Node](https://img.shields.io/badge/node-24+-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build%20step-3178C6?logo=typescript&logoColor=white)](https://nodejs.org/api/typescript.html)
[![Twilio](https://img.shields.io/badge/Twilio-ConversationRelay%20%C2%B7%20Orchestrator-F22F46?logo=twilio&logoColor=white)](https://www.twilio.com/docs)
[![Langfuse](https://img.shields.io/badge/Langfuse-self--hosted%20v4-0A0A0A)](https://langfuse.com)
[![Tests](https://img.shields.io/badge/tests-350%20passing-F22F46)](ARCHITECTURE.md#proof-not-claims)

[What it shows](#what-it-shows) · [Capabilities](#capabilities) · [Tools](#tools) ·
[How it fits together](#how-it-fits-together) · [Architecture](ARCHITECTURE.md) ·
[Deploy](DEPLOY.md) · [Deep record](docs/HANDOFF.md)

</div>

---

A clonable starting point for customer-facing Twilio demos. The agent answers a phone call, answers a
text, remembers the caller between conversations, searches a knowledge base, and hands the call to a
human when asked — all from one channel-agnostic core.

The interesting part is not that it works. It is **what is wired up around it**: the three things
mature implementations have and proofs-of-concept never do.

> [!IMPORTANT]
> **This is a demo scaffold, not a production service.** It is built for the "art of the possible"
> conversation. It degrades loudly rather than failing safely, several endpoints are unauthenticated,
> and it assumes one process holds conversation state in memory. Those are choices —
> [`docs/HANDOFF.md`](docs/HANDOFF.md) names each one under "Gaps and honest limits".

## What it shows

**1. Telemetry you can argue with**

- Every turn is one Langfuse trace: prompt fetch, tool selection, model call, each tool, first-token latency.
- Voice traces are **tiled** — `turn.voice` and `caller.turn` alternate with 0 ms of gap, so the root span is fully accounted for.
- "Is it us or the model?" is one attribute, not an investigation.

**2. Prompts that ship without a deploy**

- Prompt, model and tool list live in Langfuse, versioned together.
- Changing behaviour is a revision labelled `production` — live in ~20 s, no redeploy.
- Langfuse down? Compiled-in defaults take over and report their version as `fallback`, so a degraded demo is visible rather than silently different.

**3. Tool selection as data**

- Which tools the agent has, and how each is *described*, is versioned with the prompt.
- A three-way resolver reconciles the prompt's list against a compiled-in catalog and the live credentials.
- Descriptions are load-bearing: one long one is the difference between the knowledge base being used and being ignored.

**4. A core that provably does not know about Twilio**

- `/bench` streams a full agent turn with **no Twilio credentials at all**.
- The Twilio SDK and `twilio-agent-connect` may only be imported from `server/twilio/` — enforced by a test.
- So the bench is a *runtime* proof that voice, SMS and the browser are three adapters over one agent.

## Capabilities

| Capability | What it does |
|---|---|
| **Voice** | Inbound calls over ConversationRelay — streaming STT/TTS, barge-in on real audio, and the agent can hang up by itself |
| **SMS** | Inbound texts through Conversation Orchestrator, answered by the same agent code |
| **Memory** | Conversation Memory across *separate* conversations — a fact from last week comes back with zero tool calls |
| **Knowledge** | `search_knowledge` against a real Twilio Knowledge Base, on both channels |
| **Human handoff** | The caller asks for a person; the call transfers to a browser softphone with a screen pop carrying the reason and the transcript so far |
| **Observability** | Every turn is a Langfuse trace, with a live SSE feed of the same events at `GET /events/stream` |
| **Versioned prompts** | Prompt + model + tool list in Langfuse, with compiled-in fallback |
| **Twilio-free bench** | A full streaming turn in a browser with no credentials |

Each is independent — see the [capability matrix](ARCHITECTURE.md#capabilities-and-what-each-one-costs)
for what its absence costs.

## Tools

| Tool | Needs | Offered on | What it does |
|---|---|---|---|
| `lookup_order` | nothing | voice · text | Looks up a demo order by number. A credential-free fake |
| `get_store_hours` | nothing | voice · text | Opening hours for a named store; returns the real locations for anything else. Also a fake |
| `search_knowledge` | Knowledge Base | voice · text | Answers policy questions — returns, refunds, shipping, warranty — from whole written articles |
| `retrieve_profile_memory` | Memory store | text | Searches the caller's *past* conversations directly, beyond what the injected context already carries |
| `end_call` | voice | voice | Hangs up. `requires: 'voice'`, so on a text-only process it degrades instead of silently doing nothing |
| `handoff` | Studio flow + softphone | voice · text | Snapshots the transcript and the reason, then transfers the caller to a human |

The first two work before any Twilio setup exists, which is what makes a fresh clone interesting. The
last four appear only once their capability does — a tool the credentials cannot support is absent from
the list rather than present and failing.

Which tools a given turn actually offers is the **prompt's** call, not the catalog's:
`demo-agent-voice` names five and deliberately omits `retrieve_profile_memory`, `demo-agent-text` names
four. Both lists are editable in Langfuse without touching code.

## How it fits together

```mermaid
flowchart LR
  phone["Phone call"]:::caller
  text["Text message"]:::caller
  human["Human agent"]:::caller

  cr["ConversationRelay<br/>streaming STT · TTS"]:::twilio
  co["Conversation Orchestrator"]:::twilio
  studio["Studio flow"]:::twilio
  tsvc["Conversation Memory<br/>Knowledge Base"]:::twilio

  adapters["server/twilio<br/>the only Twilio-aware code"]:::app
  core["agent core — one turn<br/>prompt → model → tools → stream"]:::core
  bench["/bench<br/>no credentials"]:::app
  soft["/softphone<br/>screen pop + transcript"]:::app

  model["OpenAI"]:::ext
  lf["Langfuse<br/>prompt + tools in · trace out"]:::ext

  phone --> cr --> adapters
  text --> co --> adapters
  adapters --> core
  bench --> core
  core --> model
  core --> tsvc
  core <--> lf
  core -. "handoff tool" .-> studio --> soft --> human

  classDef caller fill:#F4F4F6,stroke:#8A94A6,color:#121C2D
  classDef twilio fill:#F22F46,stroke:#F22F46,color:#FFFFFF
  classDef app fill:#FFFFFF,stroke:#F22F46,color:#121C2D
  classDef core fill:#121C2D,stroke:#121C2D,color:#FFFFFF
  classDef ext fill:#F4F4F6,stroke:#121C2D,color:#121C2D
```

Voice, SMS and the browser are three adapters over **one** `runTurn`. Everything channel-specific — how
audio arrives, how a reply is delivered, how a call ends — stays in `server/twilio/`, and the core cannot
import it.

**→ [ARCHITECTURE.md](ARCHITECTURE.md)** has the request path in detail, the capability matrix, the source
layout, the five boundaries enforced by tests, and what a trace actually contains.

## Running it

Infrastructure it needs, in full:

- **Node 24+** and **pnpm 11**. Node runs the TypeScript directly — there is no build step for the agent.
- An **OpenAI API key**. That alone gets you a working agent and the browser bench.
- **Docker**, only for the self-hosted Langfuse stack or to run the two services as containers.
- A **public HTTPS host**, only for inbound calls and texts. A tunnel, a reverse proxy, or a hosted URL —
  the scaffold does not care which, but three places have to agree on it.

```bash
pnpm install
cp .env.example .env    # then read it — it documents what each variable costs
pnpm dev:all            # agent :8910 + web :3000
```

**→ [DEPLOY.md](DEPLOY.md)** is the operator's guide: configuration, both run modes, containers behind a
reverse proxy, wiring the Twilio side, the seed scripts, the diagnostics, and the handful of mistakes
that produce a green-looking stack and a silent phone call.

## Learn more

| Document | What's in it |
|---|---|
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | The moving parts: request path, capability matrix, source layout, the boundaries tests enforce, trace anatomy |
| [**DEPLOY.md**](DEPLOY.md) | Run it, containerise it, point real phone traffic at it |
| [**docs/HANDOFF.md**](docs/HANDOFF.md) | The deep record: what was built and *measured* task by task, where reality contradicted the plan, the latency waterfall, and the honest limits |
| [**`.env.example`**](.env.example) | The real configuration documentation — every entry says what breaks when it is absent |
| [**CLAUDE.md**](CLAUDE.md) | What an AI coding agent needs before changing anything here |

`docs/HANDOFF.md` is long, and that is the point: most of it is findings that cost real time to
discover once.
