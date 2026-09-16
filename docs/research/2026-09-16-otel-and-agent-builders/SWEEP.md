# Candidate sweep

## Bottom line

Three survive: **Coze Studio (+ Coze Loop)**, **Sim** (formerly Sim Studio), and **Windmill**. Everything else on your list fails on one of the three hard requirements, and the two failure modes you flagged account for most of it.

---

## The two disqualifiers people get wrong — confirmed

**Non-OSI licenses.** Named exactly:

| Tool | Exact license | Verdict |
|---|---|---|
| **n8n** | **Sustainable Use License** (since 2022-03-17, replacing Apache 2.0 + Commons Clause). Plus `LICENSE_EE.md` for any file/dir matching `.ee.` / `.ee`. | Fails req 1. n8n itself says it is **not** OSI open source — "source-available," use restricted to "internal business purposes." |
| **Arize Phoenix** | **Elastic License 2.0** for the Phoenix server and `arize-phoenix-evals`; only `arize-phoenix-otel` is Apache 2.0. | Fails req 1 on OSI grounds (and req 3 regardless). Third-party lists calling Phoenix "Apache 2.0" are wrong. |
| **Open WebUI** (Pipelines) | BSD-3-Clause **plus a fourth branding clause** added in v0.6.6 (2025-04-19). GitHub reports `NOASSERTION`. Open WebUI concedes it "is not an OSI-approved 'open source' license." Rebranding exempt only ≤50 users / enterprise license. | Fails req 1. Also a chat UI, not an agent builder. |
| **Botpress** | v12 self-hosted is AGPLv3 + Botpress Proprietary (dual); the current `botpress/botpress` repo is MIT but is SDK/integration packages, **not a self-hostable platform**. Self-hosting is sunset — no new deployments. | Fails req 1 in practice: the product is now SaaS-only. |
| **FastGPT** | "FastGPT Open Source License" (Apache 2.0 **plus** extra terms, no unauthorized SaaS). | Non-OSI. |
| **Typebot** | Functional Source License (FSL). | Non-OSI. |
| **Activepieces** | MIT core + **Commercial License** for `packages/ee` and `packages/server/api/src/app/ee`. **Agents and Chat are explicitly excluded from Community Edition.** | Textbook "open core where the feature we need is paid." Fails req 1 as scoped. |

**Prompt-management / observability tools mistaken for agent builders.** These do not orchestrate and do not run tools. They fail req 3 outright, and most fail req 2 because they are not in the request path at all:

- **Agenta** (MIT) — prompt management, evals, observability. No orchestration runtime.
- **Opik** (Comet, Apache 2.0) — tracing, datasets, experiments, prompt management. Bills per span. No runtime.
- **Arize Phoenix** (ELv2) — Arize states its own design principle: *"we chose not to work on prompt management, believing that applications depending on an observability tool at runtime was an ill-advised design"*, and *"The runtime handles execution; Phoenix handles observability. Neither needs to know about the other."*
- **Lunary** (Apache 2.0 CE, paid EE) — observability + prompt templates. No runtime.
- **Helicone** — proxy / AI-gateway + observability. It sits in the path but owns neither prompt, orchestration, nor tools.
- **PromptLayer** — **no self-host at all**; all docs point at `api.promptlayer.com`, `PROMPTLAYER_BASE_URL` is only an override. Fails req 1.
- **Pezzo** (Apache 2.0) — prompt management; **effectively dead**: last release v0.9.2 on 2024-05-15, `pezzolabs/examples` archived 2023-08-23, Python client last touched Sept 2023.
- **Latitude** (relicensed LGPL-3.0 → **MIT**) — has **pivoted to being "the open-source AI monitoring platform."** Its current repo is telemetry, trace search, PII redaction, and "Agent Dispatch" (dispatching Claude Code/Cursor at a failing trace). Not an agent builder for your runtime. Fails req 3.

Any of these could replace part of Langfuse. None replaces your agent.

---

## Remaining candidates, one line each

- **Microsoft Prompt Flow** — **retired.** Feature development ended 2026-04-20; full retirement (read-only) 2027-04-20. `promptflow-runtime`, `promptflow-runtime-stable` and `promptflow-python` images are **already frozen, including security updates**. Successor is Microsoft Agent Framework (a code SDK, not a builder). Dead on arrival.
- **Julep** (Apache 2.0, docker-compose, real tool system) — **hard fail on req 2.** The FAQ is explicit: *"Streaming support is currently planned but not implemented"* and, under known limitations, *"Streaming Not Available: Planned feature, not yet implemented."* That is exactly the "one completed string per turn" failure that puts full generation time in the caller's ear. Otherwise it would have been a contender.
- **Inferable** (MIT, self-hostable control plane) — dormant. Latest commits across `/control-plane`, `/app`, `/cli` are Feb–Mar 2025; sibling repos marked "Public archive." Not worth depth.
- **Superagent** — the agent framework is dead; the org pivoted entirely to AI security (prompt-injection guarding). Fails req 3 by no longer existing as a builder.
- **Chainlit** — a chat **UI** library for a Python app you write. It streams well but owns neither prompt nor tools. Fails req 3.
- **TypingMind** — proprietary, paid chat frontend. Fails req 1.
- **Vapi / Bland** — neither is open source. Bland's "fully self-hosted" marketing means *Bland* hosts its own model, not that you can. Both fail req 1.
- **AutoGen Studio** — `microsoft/autogen` has been in **maintenance mode since Oct 2025**; Studio inherits that. Streaming is fine post-v0.4, but req 3 breaks on the architecture: everything is a declarative JSON spec, so **only serializable properties are expressible** — callables and object-valued fields (`is_termination_msg`, custom reply functions, hooks) cannot be authored in the UI and Studio substitutes a fixed "best effort." Microsoft also states it is "not production ready" with no authentication.
- **CrewAI Studio** (`strnad/CrewAI-Studio`) — a community Streamlit GUI over CrewAI. Streamlit is the wrong shape for a WebSocket token relay, and CrewAI's crew-completion model is turn-final, not delta-first. Fails req 2.
- **Kestra** (Apache 2.0 core) — a data/workflow orchestrator with an AI Agent task, but the execution model is task-outputs, not token deltas. Fails req 2.
- **RAGFlow** (Apache 2.0) — genuinely strong RAG plus an agent canvas, but it is a document-retrieval product; tool authoring and streaming to an external relay are not its design center. Near-miss, not top 4.
- **Sim's Copilot caveat** — the *conversational builder* ("Chat/Copilot") is a Sim-managed cloud service requiring `COPILOT_API_KEY` from sim.ai even when self-hosted. This gates the AI-assist authoring experience, **not** the runtime. Not a req-1 failure, but know it before you demo it.

---

## The three that deserve full depth

### 1. Coze Studio (+ Coze Loop) — ByteDance. Strongest overall.

- **Req 1: clean.** Root `LICENSE-APACHE`, pure Apache 2.0, no `ee` carve-out and no SaaS clause — notably cleaner than Dify's or FastGPT's terms. `docker/docker-compose.yml` is `name: coze-studio`, comes up with `docker compose --profile "*" up -d`, UI on `:8888`.
- **Req 2: clears it.** The OpenAPI chat protocol emits `conversation.message.delta` alongside `conversation.message.completed` / `conversation.chat.created` / `conversation.chat.completed`. Documented streaming endpoints include **Stream Run Workflow** and **Stream Run Chatflow**. That is the delta-per-token shape ConversationRelay wants.
- **Req 3: clears it.** Plugins are HTTP tool definitions registered in the UI, *and* workflows have a **code node that executes Python** — the repo README's own security warning names "Python execution environments in workflow code nodes" as a risk when exposed publicly, which is the strongest confirmation the OSS build really runs it.
- **Visual authoring: best in class here.** Drag-and-drop workflow canvas; Prompts, Plugins, Knowledge, Database and Variables as first-class resources; and it is the open-sourced core of a commercial product used by "tens of thousands of enterprises" — so the non-engineer path is real, not aspirational.
- **Langfuse replacement:** Coze Studio itself has **no built-in LLMOps** — you deploy **Coze Loop**, ByteDance's separate Apache-2.0 prompt-optimization/observability repo. A second stack, but the intended pairing.
- **Costs to budget:** eleven containers (MySQL 8.4, Redis, Elasticsearch 8.18, MinIO, etcd, Milvus 2.5, nsqlookupd/nsqd/nsqadmin, server, nginx web). Also **no RBAC/multi-user permissions**, **no DSL export/import** (in-workspace copy only, so no git-tracked config), no knowledge-base API, and only ~18 bundled plugins.

### 2. Sim (formerly Sim Studio) — best fit for your specific relay.

- **Req 1: mostly clean.** Root LICENSE is Apache 2.0. There **is** an `apps/sim/ee/` directory under a "Sim Enterprise License" (dev/test/eval and internal non-production only; production needs a subscription) covering `sso`, `access-control`, `audit-logs`, `scim`, `whitelabeling`, `data-retention`, `data-drains`, `workspace-forking`, `credential-groups`, `session-policy`, and — worth noting — **`custom-blocks`**. None of that is on your path: the demo is ≤5 users, and *custom tools* live in the OSS tree, not `ee`. `docker compose -f docker-compose.prod.yml up -d` brings up app + Postgres/pgvector + realtime socket server — far lighter than Coze.
- **Req 2: clears it, verifiably in source.** `POST /api/workflows/[id]/execute` is documented in-code as *"Supports both SSE streaming (for interactive/manual runs) and direct JSON responses (for background jobs)."* `apps/sim/lib/workflows/streaming/forward-agent-stream-events.ts` bridges the provider sink onto an SSE vocabulary of `stream:thinking` / `stream:tool` / **`stream:chunk`** + `stream:chunk_reset`. Token chunks and tool events on one SSE stream is precisely the shape you'd bridge into `twilio-agent-connect`.
- **Req 3: clears it most cleanly of the three.** Settings → Custom Tools takes an OpenAI function-calling JSON **schema** in one tab and a **JavaScript function body** in the other; schema params bind as bare variables; `await`, `fetch()` and Node built-ins (`crypto`, `Buffer`) are available; secrets are `{{KEY}}` placeholders bound out-of-source at execution time and masked in the trace before the tool result returns to the model. No npm packages — plan HTTP-out for anything heavy. Note the deliberate split: custom tools are model-invoked inside Agent blocks; the **Function block** is the deterministic-execution equivalent.
- **Visual authoring:** block canvas, per-block model selection with BYOK, Tables / Files / Knowledge Bases / scheduled tasks as workspace resources, run logs, and deploy surfaces for API, Chat and MCP. `docker-compose.ollama.yml` (`--profile local-gpu` / `local-cpu`) and vLLM support give a fully offline path.
- **Langfuse replacement:** partial. Versioned deployments plus run logs, but not LLM-native trace analytics at Langfuse's depth.

### 3. Windmill — the sleeper, and the best answer to requirement 3.

- **Req 1: clears it, with a caveat to weigh.** Core is **AGPLv3** (frontend portions Apache 2.0); only code behind the `enterprise` compile flag is proprietary, and the non-enterprise build / Community Edition Docker images are fully AGPLv3. AGPLv3 **is** OSI-approved, so it passes as written — but it is network copyleft, which matters if this scaffold ever ships as a hosted product. (A Kestra comparison page claiming Windmill is Apache 2.0 is simply wrong.)
- **Req 2: clears it, explicitly.** The AI agent step streams **token deltas, tool calls, and tool results** as structured JSON, consumed via **webhook SSE endpoints** — runnables expose SSE stream webhooks that trigger the job and return the stream.
- **Req 3: arguably the best of the three.** Tools *are* Windmill scripts, and one of the three sources is **inline scripts written directly in the flow**, in TypeScript or Python, in Windmill's own editor. Each tool carries a name plus a description guiding the model. Definition and implementation both genuinely live inside the builder, in a real editor with real types — not a JSON textarea.
- **Prompt versioning:** a saved `ai_agent` resource holds provider/model, system prompt, temperature, output schema, memory and tools; linked flows share it and edits propagate. **Resolution is live, not pinned** — editing an agent mid-flight affects steps that have not started, while inline agents are snapshotted with the run. Same live-edit ergonomic as your Langfuse prompts today (~20 s TTL), and the same footgun.
- **Also:** nested AI agents (coordinator → sub-agent), MCP servers as tools, ~20 ms per-step overhead — relevant against your measured 84 ms framework budget.
- **Weakest on:** visual polish for a non-engineer (a developer's DAG editor, not Coze's canvas) and LLM-native tracing (run logs per step, not generation-level analytics). It would replace Langfuse least well.

---

## Categories you have not considered

1. **The ByteDance OSS stack.** Coze Studio + Coze Loop is the single biggest omission from your candidate list, and on paper the strongest match.
2. **Voice-native agent orchestration frameworks with visual editors** — **Pipecat** (Daily; `Pipecat Flows` ships an actual visual flow editor), **LiveKit Agents**, **Vocode**. All Apache/MIT and self-hostable. These are architecturally *upstream* of your question: they own STT/TTS/interruption and would **replace ConversationRelay**, not sit behind it. Worth a deliberate decision rather than an omission, because Pipecat Flows is the only genuinely visual *voice*-agent authoring tool in the open-source world. 2026 pricing tiers put Pipecat Cloud and LiveKit Cloud in the cheapest "pure orchestration" band ($0.01/min + model at cost) precisely because the frameworks are open.
3. **The Chinese-origin LLMOps builder cluster** beyond Coze: **Bisheng** (DataElem), **FastGPT** (non-OSI license), **RAGFlow** (Apache 2.0, agent canvas plus agent memory added Dec 2025). This is where most recent visual-builder innovation is happening, and it is systematically underrepresented in English-language roundups.
4. **Durable-execution engines** — Temporal, Restate, Inngest, plus Windmill in this mode. Code-first, no visual prompt surface, but they address the mid-call-drain and resume problems your HANDOFF flags. Complementary rather than replacing.
5. **The hybrid you may actually want: keep your TypeScript runtime, move only the *tools* into a self-hosted MCP builder.** Sim, Activepieces and Windmill all expose flows as MCP servers. That satisfies "a non-engineer wires a tool" without surrendering token streaming or the TAC integration — the one requirement your current architecture handles best and every builder handles worst.
6. **Agent-config specification standards** — Open Agent Spec / WayFlow, Google ADK (Apache 2.0, `adk web` dev UI, true bidirectional streaming). Code frameworks with dev UIs; they'd move your tools from TypeScript to Python rather than into a builder, so they fail req 3 in spirit. Named for completeness, not recommended.

## Citations

- https://blog.n8n.io/announcing-new-sustainable-use-license/
- https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/prompt-flow-is-being-retired/4513587
- https://learn.microsoft.com/en-us/azure/machine-learning/prompt-flow/migrate-prompt-flow-to-agent-framework
- https://docs.julep.ai/FAQ
- https://github.com/julep-ai/julep
- https://arize.com/blog/prompt-management-from-first-principles/
- https://arize.com/blog/add-observability-to-your-open-agent-spec-agents-with-arize-phoenix/
- https://arize.com/docs/phoenix/self-hosting/license
- https://www.openwebui.com/license
- https://github.com/open-webui/docs/blob/main/docs/license.mdx
- https://github.com/open-webui/open-webui/discussions/8467
- https://www.activepieces.com/docs/about/license
- https://www.activepieces.com/solutions/open-source-developers
- https://community.activepieces.com/t/is-activepieces-still-open-source/2838
- https://github.com/windmill-labs/windmill/blob/main/LICENSE
- https://www.windmill.dev/docs/core_concepts/ai_agents
- https://www.windmill.dev/docs/core_concepts/streaming
- https://www.windmill.dev/platform/flow-editor
- https://github.com/coze-dev/coze-studio
- https://github.com/coze-dev/coze-studio/blob/main/README.md
- https://github.com/coze-dev/coze-studio/wiki/2.-Quickstart
- https://github.com/coze-dev/coze-studio/blob/main/docker/docker-compose.yml
- https://github.com/coze-dev/coze-studio/blob/main/frontend/packages/studio/open-platform/open-chat/src/components/studio-open-chat/provider/coz-sdk/api-adapter/message/message-parser.ts
- https://medium.com/@cyan747/comparison-of-ai-development-tools-key-difference-facts-between-dify-and-coze-studio-open-source-3a3657b0a60c
- https://jimmysong.io/blog/open-source-ai-agent-workflow-comparison/
- https://github.com/simstudioai/sim
- https://github.com/simstudioai/sim/blob/main/LICENSE
- https://github.com/simstudioai/sim/blob/main/apps/sim/ee/LICENSE
- https://github.com/simstudioai/sim/blob/main/apps/docs/content/docs/agents/custom-tools.mdx
- https://github.com/simstudioai/sim/blob/main/apps/sim/app/api/workflows/%5Bid%5D/execute/route.ts
- https://github.com/simstudioai/sim/blob/main/apps/sim/lib/workflows/streaming/forward-agent-stream-events.ts
- https://www.sim.ai/library/best-ai-agent-builder-2026
- https://github.com/botpress/v12
- https://github.com/botpress/botpress/blob/master/LICENSE
- https://rasa.com/blog/rasa-vs-botpress
- https://github.com/inferablehq/inferable
- https://github.com/superagent-ai/superagent
- https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/
- https://newsletter.victordibia.com/p/autogen-studio-v04-a-no-code-tool
- https://atlan.com/know/ai-agent/what-is-autogen/
- https://github.com/strnad/CrewAI-Studio/
- https://github.com/pezzolabs/pezzo
- https://www.promptlayer.com/glossary/helicone-vs-promptlayer/
- https://github.com/latitude-dev/latitude-llm
- https://docs.latitude.so/
- https://agenta.ai/blog/top-open-source-prompt-management-platforms
- https://lunary.ai/faq
- https://docs.vapi.ai/
- https://www.bland.ai/blog/bland-vs-vapi-which-ai-voice-platform-is-right-for-enterprise
- https://softcery.com/ai-voice-agents-calculator
- https://github.com/infiniflow/ragflow
- https://www.turingpost.com/p/rag-tools
- https://madappgang.com/blog/open-source-visual-agent-builders-compared-flowise-vs-langflow-vs-n8n-vs-sim-studio-in-2026/
- https://kestra.io/vs/windmill

## Unverified

- Coze Studio's token-delta streaming was confirmed from `conversation.message.delta` in the frontend SSE parser (`message-parser.ts`) plus wiki-documented "Stream Run Chatflow" / "Stream Run Workflow" endpoints. I did not place a live call against a self-hosted `coze-server` to observe deltas on the wire from the OSS backend, so 'the OSS build emits per-token deltas over /v3/chat' is inferred, not measured.
- Coze Studio's `docker/docker-compose.yml` has no dedicated code-sandbox service, so the Python code node presumably executes in-process in `coze-server`. The README security warning implies it works; I did not confirm where or how it is isolated, which matters given your stack publishes on a public host.
- Whether Coze Studio's code node supports JavaScript in the open-source build. Only Python is named in the repo README; JS is documented on the commercial Coze docs center, which the corporate Zscaler proxy blocked.
- Windmill's AI-agent SSE stream was read from Windmill's own docs, not from source or a running instance. I did not verify the exact event/payload shape.
- Whether Windmill's AI agent step exists in the Community Edition Docker image at all, or is gated behind the `enterprise` compile flag. This is the single most load-bearing unknown for candidate 3 — check it before investing depth.
- Sim's `stream:chunk` events were confirmed in source at `apps/sim/lib/workflows/streaming/forward-agent-stream-events.ts` and the execute route's own doc comment. I did not run Sim and observe an SSE stream, so per-token (vs per-sentence-buffer) granularity is unconfirmed.
- Whether Sim's Agent-block streaming survives the v2 API path: `apps/sim/app/api/v2/workflows/[workflowId]/execute/route.ts` uses `application/x-ndjson` with a 15 s heartbeat, a different transport from the v1 SSE route. Which one a ConversationRelay bridge should target is unresolved.
- The exact current status of `microsoft/promptflow` on GitHub — the retirement notice is in `docs/index.md`, but I found no explicit "This repository has been archived" banner.
- Botpress v12's true last release date — sources conflict (2023-06-22 vs April 2025). Immaterial to the verdict, since self-hosting is sunset either way.
- Bisheng's current LICENSE file. Commonly described as Apache 2.0 with an enterprise edition, but it did not surface in results and Chinese-origin platforms have added SaaS clauses over time.
- Whether Coze Loop's Apache 2.0 license carries the same no-extra-restrictions cleanliness as Coze Studio's. I confirmed Studio's `LICENSE-APACHE` directly; Loop's was reported second-hand.
- Latitude's current runtime surface. It clearly relicensed LGPL-3.0 to MIT and repositioned to monitoring, but I could not confirm whether the older prompt-as-agent `/run` gateway with server-side tool execution still ships. If it does, Latitude deserves a second look.
- Pipecat Flows' visual editor maturity and license — named from prior knowledge and one pricing-table reference, not verified against the repo this session.
