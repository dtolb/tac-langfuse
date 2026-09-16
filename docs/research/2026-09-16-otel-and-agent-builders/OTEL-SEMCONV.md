# OTel GenAI semantic conventions

## What I read, and when

The GenAI conventions **no longer live in `open-telemetry/semantic-conventions`**. As of that repo's v1.42.0 they were moved out; `docs/gen-ai/gen-ai-spans.md` in the main repo is now a stub reading "**Moved: Generative AI semantic conventions** … no longer maintained in this repository." The live spec is `open-telemetry/semantic-conventions-genai`, created 2026-05-05.

I read that repo's `main` at commit dated **2026-09-16T01:52Z** (my read date 2026-09-16). Version identity, from `model/manifest.yaml`:

```yaml
schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev
stability: development
dependencies:
  - schema_url: https://opentelemetry.io/schemas/1.44.0   # core semconv v1.44.0
```

**There is no tagged release and no GitHub release in the GenAI repo** — `/tags` and `/releases` are both empty. So there is no citable stable version number; you cite a commit or the `gen-ai-dev/1.42.0-dev` schema URL. Core semconv's latest release is v1.44.0. For a page about "instrumenting correctly," that is the most important fact: the target is an untagged `-dev` registry that changed as recently as the day I read it (a merged PR dated 2026-09-16, "Allow conversation ID on tool execution spans (#518)").

## Status: nothing is stable

Every document carries `**Status**: [Development]` — `README.md`, `gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-metrics.md`, `gen-ai-events.md`. Every `gen_ai.*` attribute, span, metric, event and enum value in the tables is badged `Development`. The manifest's `stability: development` says the same at registry level.

The only **Stable** things on a GenAI span are borrowed from core semconv v1.44.0: `error.type`, `server.address`, `server.port`. No `gen_ai.*` attribute is Stable or Release-Candidate. No stabilization date appears in the docs.

## Span naming

Inference span: **name SHOULD be `{gen_ai.operation.name} {gen_ai.request.model}`** (e.g. `chat gpt-4o`). Kind SHOULD be `CLIENT`, MAY be `INTERNAL` for models in the same process. Frameworks MAY define a different format.

The others, from `gen-ai-agent-spans.md`:

| Operation | Span name | Kind |
|---|---|---|
| `create_agent` | `create_agent {gen_ai.agent.name}` | CLIENT |
| `invoke_agent` (hosted/remote) | `invoke_agent {gen_ai.agent.name}` if name readily available | **CLIENT** |
| `invoke_agent` (in-process) | same | **INTERNAL** |
| `invoke_workflow` | `invoke_workflow {gen_ai.workflow.name}` | INTERNAL |
| `plan` | `plan {gen_ai.agent.name}`, else bare `plan` | INTERNAL |
| `execute_tool` | `execute_tool {gen_ai.tool.name}` | INTERNAL |
| `retrieval` | (defined in `gen-ai-spans.md`) | CLIENT |

### Required vs recommended on the inference span

**Required (2):** `gen_ai.operation.name`, `gen_ai.provider.name`. Everything else is Conditionally Required, Recommended, or Opt-In.

**Conditionally Required:** `error.type` (on error), `gen_ai.conversation.id` ("if and only if the instrumented library has one readily available, or the user application provides one"), `gen_ai.output.type`, `gen_ai.prompt.name` (when a named prompt template is used), `gen_ai.prompt.version`, `gen_ai.request.model` (if available), `gen_ai.request.stream`, `gen_ai.request.seed`, `gen_ai.request.choice.count`, `gen_ai.request.top_k`, `server.port`.

**Recommended:** `gen_ai.request.{temperature,top_p,max_tokens,stop_sequences,frequency_penalty,presence_penalty,previous_response.id,reasoning.level}`, `gen_ai.response.{id,model,finish_reasons}`, **`gen_ai.response.time_to_first_chunk`**, `gen_ai.conversation.compacted`, `server.address`, and the token-usage family: `gen_ai.usage.{input_tokens,output_tokens,reasoning.output_tokens}`, per-modality `gen_ai.usage.{text,image,audio}.{input_tokens,output_tokens,cache_read.input_tokens}`, and `gen_ai.usage.{cache_read,cache_write}.input_tokens`.

**Opt-In (content):** `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.prompt.variable`.

Relevant to a versioned-prompt story: **`gen_ai.prompt.name` and `gen_ai.prompt.version` are real spec attributes**, Conditionally Required when a named prompt template is used, with examples `analyze-code` and `1.0.0` / `2025-05-01` / `prod` / `v2`. That maps directly onto a Langfuse-versioned prompt.

`gen_ai.operation.name` well-known values: `chat`, `text_completion`, `generate_content`, `embeddings`, `retrieval`, `fetch_response`, `execute_tool`, `create_agent`, `invoke_agent`, `invoke_workflow`, `plan`, plus a memory family (`create_memory_store`, `delete_memory_store`, `create_memory`, `update_memory`, `upsert_memory`, `delete_memory`, `search_memory`).

## Agent, tool, and multi-turn modeling

**Agent invocation.** Dedicated conventions exist, and the CLIENT/INTERNAL split is normative, not a hint. The hosted `invoke_agent` CLIENT span requires `gen_ai.operation.name` **and** `gen_ai.provider.name` and carries `server.*`; the in-process `invoke_agent` INTERNAL span requires only `gen_ai.operation.name` — `gen_ai.provider.name` is not in its Required set. Identity: `gen_ai.agent.id` (Conditionally Required if applicable; provider-assigned stable id, e.g. a Bedrock agent ARN), `gen_ai.agent.name` and `gen_ai.agent.description` (Conditionally Required when available). Multi-agent orchestration gets `invoke_workflow` + `gen_ai.workflow.name`.

**Tool execution.** `execute_tool` is defined in `gen-ai-spans.md`; the agent doc only cross-references it. Required: `gen_ai.operation.name`, `gen_ai.tool.name`. Conditionally Required: `error.type`, `gen_ai.agent.name` ("when applicable" — the agent executing the tool), `gen_ai.conversation.id` (if available; this is the #518 change from 2026-09-16). Recommended: `gen_ai.tool.call.id`, `gen_ai.tool.description`, `gen_ai.tool.type` (`function` | `extension` | `datastore`). Opt-In: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`. `gen_ai.agent.name` is marked sampling-relevant on `execute_tool` and `plan` (#495), so it must be set at span creation time.

**Multi-turn grouping.** The only mechanism is the attribute **`gen_ai.conversation.id`** — "The unique identifier for a conversation (session, thread), used to store and correlate messages within this conversation," example `conv_5j66UpCpwteGg4YSxUnt7lPY`. There is **no conversation span**, no parent-child convention across turns, and no use of the general `session.id` attribute. Grouping is a flat correlation key stamped on each turn's spans. For a phone call the spec offers nothing better than "put the call SID in `gen_ai.conversation.id`." Also present: `gen_ai.conversation.compacted` (boolean, Recommended when available) for when the effective context is a compacted view of prior history.

## Prompts and completions: attributes vs events

Three patterns, with a named default (`gen-ai-spans.md` → "Capturing instructions, inputs, and outputs"):

1. **Default: don't record them.** "OpenTelemetry instrumentations SHOULD NOT capture them by default, but SHOULD provide an option for users to opt in."
2. Record on the span via `gen_ai.system_instructions` / `gen_ai.input.messages` / `gen_ai.output.messages` — "best suited for situations where telemetry volume is manageable and either privacy regulations do not apply or the telemetry storage complies with them, for example, in pre-production environments."
3. Store content externally, record references on the span — "recommended in production environments." Instrumentations MAY support an in-process upload hook, which SHOULD run independently of the opt-in flags and regardless of the sampling decision. The spec then states `TODO: document a common approach to record references to externally stored content` — so pattern 3 is recommended but not actually specified.

**Spans vs events.** Both supported; the split is pragmatic, not semantic. Message payloads follow JSON schemas (`model/gen-ai/gen-ai-input-messages.json`, `gen-ai-output-messages.json`), and the doc warns that "recording structured attributes is supported on events (or logs) and **may not yet be supported on spans**," pending OTEP 4485. Guidance: "If structured attributes are not yet supported on spans in a given language, the corresponding attribute value SHOULD be serialized to JSON string on spans and recorded in its structured form on events." The detail-carrying event is **`gen_ai.client.inference.operation.details`** (name MUST be exactly that). A second event exists: `gen_ai.evaluation.result`.

**Privacy switch.** The spec names an example env var rather than mandating one: **`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`** ("by an explicit user opt-in, for example …"). The older `OTEL_SEMCONV_EXPERIMENTAL_GEN_AI_CAPTURE_MESSAGE_CONTENT` spelling appears nowhere in current docs. Instrumentations MAY offer truncation of individual message contents while preserving JSON structure.

## Streaming and time-to-first-chunk — the definitive answer

Streaming is covered, in both signals.

**Span attribute:** `gen_ai.response.time_to_first_chunk` — double, **seconds**, Recommended "If the request was a streaming request." Definition: "Time to first chunk in a streaming response, measured from request issuance, in seconds. The value is measured from when the client issues the generation request to when the first chunk is received in the response stream." Examples `0.5`, `1.2`. Appears on the inference span and on `gen_ai.client.inference.operation.details`.

**Metrics:**
- `gen_ai.client.operation.time_to_first_chunk` — Histogram, unit `s`, client-side.
- `gen_ai.client.operation.time_per_output_chunk` — Histogram, `s`, per chunk after the first, measured end-of-previous-chunk to end-of-current.
- `gen_ai.client.operation.duration` — Histogram, `s`.
- Server-side: `gen_ai.server.time_to_first_token`, `gen_ai.server.time_per_output_token`, `gen_ai.server.request.duration`.
- Agent/tool/workflow: `gen_ai.invoke_agent.duration`, `gen_ai.invoke_agent.inference_calls`, `gen_ai.invoke_agent.tool_calls`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_workflow.duration`.

**So: `gen_ai.client.operation.time_to_first_chunk` is a real, spec-defined name — but the spec defines it as a METRIC (a histogram), not a span attribute.** The Vercel AI SDK emits that exact string as a **span attribute**, which is the one thing the spec does not do with it. The spec's span-attribute name for the identical measurement is `gen_ai.response.time_to_first_chunk`.

Verdict, precisely: not an SDK invention — the name and the seconds unit are both straight from the spec, and the measurement boundaries match word for word — but not spec-conformant as used, because it is a spec metric name applied at the wrong signal. "De-facto" undersells it; the accurate framing is **"right name, right unit, wrong signal."** The AI SDK docs say: `"gen_ai.client.operation.time_to_first_chunk": time to the first streamed output chunk, in seconds (streaming calls only)`. Its legacy `ai.*` mode emits `ai.response.msToFirstChunk` in **milliseconds**, so moving between the SDK's two modes silently changes units by 1000×. For spec-clean spans, alias to `gen_ai.response.time_to_first_chunk` (same value, no conversion) and additionally record the histogram under `gen_ai.client.operation.time_to_first_chunk`.

One real gap: `gen-ai-spans.md` has a section headed **"Streaming chunks"** whose entire body is `TODO`. Per-chunk span events are unspecified.

## Voice: uncovered by the spec, with three open PRs

**There is no merged convention for STT, TTS, audio latency, barge-in, or realtime voice sessions.** No `speech_to_text` or `text_to_speech` operation, no audio-latency attribute or metric, nothing about time-to-first-audio or playback. Grepping all five GenAI docs for audio/speech/voice/STT/TTS/transcription/realtime returns only two merged things:

1. **Audio token usage**: `gen_ai.usage.audio.input_tokens`, `gen_ai.usage.audio.output_tokens`, `gen_ai.usage.audio.cache_read.input_tokens` (int, Recommended when applicable). Their values SHOULD be included in the aggregate `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens`.
2. **`speech` as a well-known value of `gen_ai.output.type`**, alongside `text`, `json`, `image`.

That is the entire voice surface. Everything else is in flight as **open, unmerged PRs**:

- **PR #390**, "Add GenAI voice agent conventions (realtime audio tokens, end reason, cascade STT/TTS)" — opened 2026-07-21, last updated 2026-09-02, open. Proposes `speech_to_text` and `text_to_speech` operations and client spans, `gen_ai.speech.voice`, `gen_ai.speech.input.language`, and `gen_ai.agent.invocation.end_reason` to capture turn outcomes **including barge-in interruptions**. Also proposes `gen_ai.usage.input_audio_tokens` / `output_audio_tokens` — note those lost to the merged `gen_ai.usage.audio.input_tokens` spelling, so parts of #390 are already stale. Ships a prior-art survey covering ElevenLabs, Pipecat, LiveKit and the OpenAI Realtime/Agents SDKs, plus an explicit "Open questions" section on whole-conversation audio and conversation-vs-span modeling.
- **PR #394**, "Realtime / live voice model generation (`generate_live_content` span)" — opened 2026-07-23, updated **2026-09-15**, the most active of the three. Its framing bears directly on tiled voice timelines: "a live session streams user audio continuously while the server streams incremental output, **so a generation cannot be represented by the client-timed `inference` span**." It proposes a `gen_ai.generate_live_content.client` span starting at the first output chunk (or an earlier voice-activity-end anchor); models the long-lived, mostly-idle session as **events, not a span** (`gen_ai.client.live_session.started` / `.ended`), correlating generations within it by `gen_ai.conversation.id`; and adds an Opt-In `gen_ai.user_input.client` span bracketed by provider VAD events (e.g. OpenAI Realtime `input_audio_buffer.speech_started`/`speech_stopped`), noting that providers without VAD events must instead carry user input on the generation span via `gen_ai.input.messages`.
- **PR #448**, "Users/singankit/voice agents live span" — opened 2026-08-11, updated 2026-09-02. Body is an unfilled template; not a usable reference.

Worth calling out on the page: #394 independently arrives at the same shape this repo already built — a session correlated by id rather than wrapped in a span, a bot-output span anchored at first output, and a separate caller-utterance span bounded by VAD/endpointing. `caller.turn` is #394's `gen_ai.user_input.client`; `turn.voice` is its `generate_live_content`. And #390's `gen_ai.agent.invocation.end_reason` is the standard-track name for the barge-in outcome the interrupt handler parks. None of it is merged, so today it is prior art, not conformance.

## Citations

- https://github.com/open-telemetry/semantic-conventions-genai
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/manifest.yaml
- https://github.com/open-telemetry/semantic-conventions-genai/pull/390
- https://github.com/open-telemetry/semantic-conventions-genai/pull/394
- https://github.com/open-telemetry/semantic-conventions-genai/pull/448
- https://github.com/open-telemetry/semantic-conventions-genai/pull/518
- https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
- https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.44.0
- https://opentelemetry.io/docs/specs/otel/document-status
- https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4485-extending-attributes-to-support-complex-values.md

## Unverified

- The claim that GenAI conventions were deprecated in the main repo specifically at semantic-conventions v1.42.0 (and the 2026-06-12 date) came from web search, not a changelog I read. I confirmed the outcome directly — the main repo's gen-ai docs are "Moved" stubs and the GenAI repo's manifest reads gen-ai-dev/1.42.0-dev — but not the exact release in which the deprecation landed.
- I did not read OTEP 4485 itself, only the spec's reference to it as the reason structured attributes may not yet work on spans.
- I did not verify against a live install which exact AI SDK version emits gen_ai.client.operation.time_to_first_chunk versus legacy ai.response.msToFirstChunk; that split comes from the AI SDK telemetry docs page as fetched.
- Whether PRs #390/#394/#448 have since been merged, closed, or superseded after their last-updated timestamps (2026-09-02, 2026-09-15, 2026-09-02). Re-check before publishing — #394 was active the day before I read it.
- I read gen-ai-spans.md, gen-ai-agent-spans.md, gen-ai-metrics.md, gen-ai-events.md and README.md, and grepped all docs for audio/voice terms. I did not fully read the provider-specific docs (anthropic.md, openai.md, aws-bedrock.md, azure-ai-inference.md) or mcp.md, so a provider-specific audio or realtime attribute could exist there.
- No tagged release exists in the GenAI repo as of my read, so the "version" cited is a commit date plus the -dev schema URL. A release process may be underway that is not visible from the API.
- gen-ai-exceptions.md was listed in the README but I did not read its contents.
