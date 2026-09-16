# Deploying and running it

The operator's guide. [`README.md`](README.md) is what the scaffold *shows*; this is how to stand it
up, containerise it, and point real phone traffic at it.

Everything here is ordered by how far you want to go: a local agent needs one API key, a browser demo
needs nothing else, and only inbound calls and texts need a public host and a configured Twilio account.

- [Requirements](#requirements)
- [Local, in one minute](#local-in-one-minute)
- [Configuration](#configuration)
- [The two run modes](#the-two-run-modes)
- [Containers](#containers)
- [Going live: the public host](#going-live-the-public-host)
- [Wiring the Twilio side](#wiring-the-twilio-side)
- [Verify before you spend anything](#verify-before-you-spend-anything)
- [Operating it](#operating-it)
- [When it looks fine and isn't](#when-it-looks-fine-and-isnt)

---

## Requirements

| | | |
|---|---|---|
| **Node 24+** | required | Runs the TypeScript directly. There is no build step for the agent |
| **pnpm 11** | required | Workspace root plus `web/` as its own install root |
| **`OPENAI_API_KEY`** | for a useful demo | The only variable that unlocks the agent itself |
| **Docker** | optional | Self-hosted Langfuse (6 containers, ~2.7 GB), and/or running the two services as containers |
| **A public HTTPS host** | for phone traffic | Tunnel, reverse proxy or hosted URL — the scaffold does not care which |
| **A Twilio account** | for phone traffic | Account SID, auth token, an API key pair, and a number |

## Local, in one minute

```bash
pnpm install
cp .env.example .env
# put OPENAI_API_KEY in .env
pnpm dev:all            # agent :8910, Next :3000
```

Then open <http://localhost:3000/bench> and type something. That is a complete agent turn — prompt
resolution, tool selection, model call, tool execution, streaming response — with no Twilio credentials
involved. Or drive it from the shell:

```bash
curl -sN -X POST http://localhost:8910/api/bench/turn \
  -H 'content-type: application/json' -d '{"text":"where is order A4721?"}'
```

`pnpm status` is read-only and answers "what is running, what is configured, and what is therefore
possible" in one screen. It is the right first command whenever something is confusing.

### Traces

```bash
pnpm langfuse           # 6 containers, ready in ~10s on warm volumes
pnpm langfuse:down
```

Langfuse UI at <http://localhost:3100>; the login is whatever you set for `LANGFUSE_INIT_USER_EMAIL`
and `LANGFUSE_INIT_USER_PASSWORD` in `.env`. Create a project, paste its public and secret keys back
into `.env`, restart the agent, and every turn becomes a trace.

> [!NOTE]
> This Langfuse is v4 in `events_only` mode, so **its read API is disabled**. `GET /api/public/traces`
> returns 404 meaning *disabled*, not *no data*. Verify traces in the UI, or in ClickHouse `events_core`.

## Configuration

**[`.env.example`](.env.example) is the configuration documentation.** It is committed, it is tested
against the code — a variable the code reads but the file does not describe fails `pnpm test` — and
every entry says what breaks when it is absent rather than just what it is. Read it top to bottom once;
it is faster than any summary of it.

Two things about it that are easy to get wrong:

- **`APP_NAME` first.** It names the containers, the reverse-proxy routers and the public hostname.
  Router names are global on a shared proxy, so two clones both left at the default will define
  identically-named routers and one demo will silently steal the other's webhooks. `pnpm preflight`
  refuses to start the stack while it is still the default or is malformed; `server/config.ts` applies
  no format validation, so nothing else will catch a capital letter or a space.
- **Some credentials may come from your shell, not `.env`.** On the machine this was built on,
  `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` and `TWILIO_API_SECRET` are exported from the shell profile,
  so `docker-compose.yml` passes them through by bare name. A container gets none of them otherwise,
  and the symptom is `/health` reporting all five Twilio variables missing while three of them are
  plainly in your shell.

Nothing is required to boot. Missing variables produce one warning each and a `/health` capability map;
see [It never dies at boot](ARCHITECTURE.md#it-never-dies-at-boot).

## The two run modes

Host processes and containers are interchangeable for development but **mutually exclusive for Twilio
traffic**, because `TWILIO_VOICE_PUBLIC_DOMAIN` names exactly one public host — whichever mode is not
named receives nothing.

### Host processes

```bash
pnpm dev:all      # agent on :8910, Next on :3000
```

Next proxies `/api`, `/events` and `/health` to the agent in dev, so browser code fetches **relative**
paths and is byte-identical in both modes.

> [!WARNING]
> The agent runs under `--watch`, so killing the listener on `:8910` just respawns it. Kill
> `scripts/dev.mjs`, the supervisor. And use `lsof -ti :8910 -sTCP:LISTEN` — without `-sTCP:LISTEN`
> the list includes any tunnel you have open and you take that down too.

### Containers

```bash
pnpm stack:up     # preflight, then docker compose up -d --build
pnpm stack:down
```

> [!WARNING]
> **Not `pnpm up`.** `up` is a built-in alias for `pnpm update`, and a package.json script cannot shadow
> a built-in — it would rewrite the pinned lockfile and start nothing.

`pnpm preflight` runs first and refuses to bring the stack up on a misconfiguration that Docker, the
proxy and the app would all otherwise accept in silence: a default or malformed `APP_NAME`, a missing
external container network, an unresolvable CA path, or an `APP_NAME` exported in your shell that
disagrees with `.env`.

## Containers

Two images, both built from the **repo root** because `web/` imports `../shared/*.ts`:

| | |
|---|---|
| `Dockerfile.agent` | Node runs the TypeScript. No build step |
| `Dockerfile.web` | Next in `standalone` mode |

Both **COPY** the source; they do not mount it. Reverse-proxy labels come from `docker-compose.yml`,
which expects an existing external network and splits one public host by path.

> [!IMPORTANT]
> **The stack does not come back by itself after a reboot, by design.** It runs `restart: "no"`, so
> starting the public surface is always an explicit act — it publishes unauthenticated endpoints on a
> stable public host. The Langfuse stack *is* `always` and does return on its own, so tooling survives
> a restart while the demo does not sit exposed unattended.
>
> Do not "fix" this to `unless-stopped`. `on-failure` is also wrong: on a VM stop the agent exits 0
> while Next exits 143, so it resurrects half the stack.

### Path routing

If the agent and the web app share one public host, whatever sits in front must send `/webhook`,
`/twiml`, `/ws`, `/conversation-relay-callback`, `/twilio/call-events`, `/api`, `/events` and `/health`
to the **agent**, and everything else to **Next**.

That list is [`shared/twilio-paths.ts`](shared/twilio-paths.ts), and a test asserts the routing config
against it — so adding a route and forgetting to route it fails the suite instead of producing a 404
that looks like a Twilio problem. The same test pins the compose filename and the label syntax.

## Going live: the public host

Inbound calls and texts need a public URL. The same value builds the media WebSocket (`wss://<host>/ws`)
and the call-action callback, and **three places must agree**:

1. `TWILIO_VOICE_PUBLIC_DOMAIN` in `.env`
2. The phone number's `voice_url`
3. The Conversation Orchestrator configuration's `statusCallbacks[0].url`

One command moves all three, backing the configuration up and re-reading the backup before the
full-replace PUT:

```bash
node --env-file-if-exists=.env scripts/repoint-public-host.ts <bare-host>          # dry run
node --env-file-if-exists=.env scripts/repoint-public-host.ts <bare-host> --write
```

> [!CAUTION]
> **Repoint BEFORE you start the stack, never after.** Backwards is the most demo-destroying mistake
> available here: the process boots green, `/health` reports `voice: ready`, routing works, and every
> call connects to the *old* host and sits in **silence with nothing in the logs**, because the
> WebSocket never arrives. `pnpm preflight` and `pnpm status` both warn when the host looks wrong.

## Wiring the Twilio side

Scripts, not console clicking. Each prints what it created so you can paste the id into `.env`.

```bash
pnpm seed:prompts               # push the compiled-in prompts to Langfuse as a new version + `production`
pnpm seed:prompts <name>        # just one — every run relabels what it touches, so prefer this
pnpm seed:knowledge             # create a Knowledge Base, push the demo articles, print the id
pnpm seed:studio                # publish the Studio flow that rings the browser softphone,
                                #   backing the live revision to disk first
```

Take a backup before any mutation. Two account-shaped traps worth not rediscovering:

- **A `70004` / `70051` "key does not have permissions" error is about the key, not the CLI.** Prove
  credentials with an endpoint that works, never with `accounts list`.
- **Testing SMS from a second number on the same account doubles every reply.** Both message legs share
  `from`/`to`, so the capture rule matches each. Use an external handset to measure reply count.

Account-specific values — SIDs, numbers, Orchestrator and Studio ids — deliberately live only in `.env`.
This repo is cloned per demo, and a committed doc carrying one account's ids hands every future clone
stale values that look authoritative.

## Verify before you spend anything

Seven diagnostics, each answering a question you cannot answer by reading code. They are cheap and none
of them needs a phone call. Each file's header says what it proves — read that rather than inferring
from the filename.

```bash
pnpm verify:turn                                              # three real turns of one conversation
node --env-file-if-exists=.env scripts/verify-model.mjs       # is the configured model reachable
node --env-file-if-exists=.env scripts/verify-prompts.ts      # live versions AND the fallback path
node --env-file-if-exists=.env scripts/verify-tools.ts        # does the catalog resolve what Langfuse serves
node --env-file-if-exists=.env scripts/verify-telemetry.ts    # does a span from THIS process reach Langfuse
node --env-file-if-exists=.env scripts/verify-memory.ts       # is memory on, has extraction produced anything
node --env-file-if-exists=.env scripts/verify-knowledge.ts    # does the KB answer what the tools cannot
```

`verify:turn` is the one that matters most. It drives **three real turns of one conversation** — live
prompt, real catalog, real model — and prints the version, tools called, TTFT and totals. Turn 2 asks a
question whose answer appears nowhere in the question, the prompt or any tool output, so a correct
answer proves the history store works; turn 3 repeats it after `clear()` and requires the answer to be
gone. **An amnesiac agent passes every other check in the repo**, because every other one drives a
single turn. It exits non-zero on a surprise, so it doubles as a smoke test.

### The free pre-flight for real traffic

```bash
twil webhook invoke --type voice --auth-token <TWILIO_AUTH_TOKEN> https://<host>/twiml
```

A **signed, simulated** Twilio webhook over the real public path — signature validation included. A 200
plus TwiML naming your host in both `wss://…/ws` and `action=…` means voice will work. This is the single
most useful free check in the repo.

### Watching a turn happen

`GET /events/stream` is a Server-Sent Events feed of every turn: `turn.start`, `prompt.fetch`,
`tool.selection`, `llm.first_token`, each `tool.execution`, `llm.response`, `turn.end`, plus a
`webhook.inbound` diagnostic that publishes **the exact URL Twilio's signature was validated against**.
That is the fastest way to tell "Twilio isn't calling us" from "our URL doesn't match what Twilio signed".

```bash
pnpm typecheck && pnpm test      # 350 tests, 20 files
```

## Operating it

Four rules, each of which has cost a debugging session at least once.

**1. Restart the agent after a code change before concluding a fix does not work.** Node does not
hot-reload. Check `ps -p <pid> -o lstart=` against the commit time first. Langfuse *prompt* edits do land
live (~20 s TTL); code does not.

**2. Containers need a rebuild after a code change, not a restart.** `pnpm stack:up` runs
`up -d --build`; the Dockerfiles COPY the source. A real call was once placed against an image built 2.5
hours earlier and the trace came back missing every new span — which reads as "the instrumentation is
broken" rather than "the code was never deployed".

**3. After any `.env` change: `docker compose up -d --force-recreate`, never `restart`.** `restart`
re-runs the existing container with its *original* env block, so the change silently does not take.

**4. Read `attributes.gen_ai.client.operation.time_to_first_chunk` before theorising about latency.**
It is a native AI SDK attribute on every generation, in seconds, and it accounts for the generation span
almost exactly. Measured across 33 generations: the framework costs 84 ms and everything else is model
time. The full waterfall and the ranked levers are in
[`docs/HANDOFF.md`](docs/HANDOFF.md) → "Latency, investigated 2026-09-15".

## When it looks fine and isn't

| Symptom | Cause |
|---|---|
| Call connects, then **silence, nothing in the logs** | `TWILIO_VOICE_PUBLIC_DOMAIN` and the number's `voice_url` disagree — the WebSocket never arrives. Repoint, then restart |
| `/health` says five Twilio variables are missing, three are in your shell | The container did not get them. They are shell-profile values passed through explicitly by compose |
| A code change has no effect | The agent was not restarted, or the container was not rebuilt. Rules 1 and 2 above |
| An `.env` change has no effect in a container | `restart` was used instead of `--force-recreate` |
| Killing `:8910` does not stop the agent | `--watch` respawned it. Kill `scripts/dev.mjs` |
| `pnpm test -- <file>` runs the whole suite | It does not filter. Use `pnpm vitest run <file>` |
| Traefik drops the service with no error on either side | The external network was not marked `external: true`, so Compose created `${APP_NAME}_edge` instead |
| Two demos steal each other's webhooks | Both left `APP_NAME` at the default. Router names are global |
| Every SMS reply arrives twice | You are texting from a number on the same account. Both legs match the capture rule |
| `GET /api/public/traces` returns 404 | Langfuse v4 `events_only` disables the read API. That is not "no data" |

Anything not here is probably in [`docs/HANDOFF.md`](docs/HANDOFF.md), which records what was *measured*
task by task, including the places reality contradicted the plan.
