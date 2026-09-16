# OTEL injection and agent builders, researched 2026-09-16

The provenance for two published pages. Nothing in here was run against a candidate: every verdict is source reading at named commits and published documentation. That limit is stated on both pages and it is the first thing to fix before acting on any recommendation.

- <https://pages-4296.twil.io/tac-otel-instrumentation>
- <https://pages-4296.twil.io/tac-agent-builder-options>

Produced by two multi-agent workflow runs, 62 agents total. Round one's builder claims were each attacked by three adversarial refuters; **17 of 18 came back refuted**, almost all as "directionally right but overstated." The corrections, not the original records, are what the pages assert. Read `OLD-CANDIDATES.md` and `R2-NEW-CANDIDATES.md` as record-then-verdict pairs, and treat `corrected_claim` as the truth wherever `refuted` is true.

## What each file is

| File | What it holds |
| --- | --- |
| `TAC-SURFACE.md` | Every extension point `twilio-agent-connect@2.2.0` exposes, cited to symbol. The load-bearing finding is here. |
| `REPO-SPANS.md` | The OTEL instrumentation this repo already had, and which attributes come free from the AI SDK. |
| `OTEL-SEMCONV.md` | GenAI semantic conventions status. They moved out of the main semconv repo; there is no tagged release. |
| `UPSTREAM-TAC.md` | Upstream repo status, and whether the callbacks are public API with a stability guarantee. They are not. |
| `CR-PROTOCOL.md` | The ConversationRelay WebSocket protocol and what it does not publish. |
| `MEASUREMENTS.md` | Every quotable number with the caveat it must carry, and the poisoned ones. |
| `CORPUS.md` | What the already-published pages cover, so these two link rather than restate. |
| `SWEEP.md` | Round one's candidate sweep, including the non-OSI licences that fail on sight. |
| `OLD-CANDIDATES.md` | Dify, Langflow, Flowise, Rivet, Letta, LangGraph, each with three verdicts. |
| `R2-NEW-CANDIDATES.md` | Mastra, Node-RED, VoltAgent, Coze Studio, Sim, Windmill, each with three verdicts. |
| `R2-GAP-traceparent.md` | Whether the trace survives moving the model call out of process. |
| `R2-GAP-authoring-surface.md` | The third integration shape: builder authors prompt and tool selection, this runtime is kept. |
| `CRITIC.md` | The completeness critic on round one's draft. Ten findings ranked by credibility damage; every one changed the final page. |
| `PAGE2-DRAFT.md` | Round one's draft, superseded. Kept because the critic's findings reference it. |
| `R2-PAGE2-FINAL.md` | The corrected prose that became the published builder page. |
| `R2-P1-surface.md`, `R2-P1-code.md`, `R2-P1-limits.md` | The three sections that became the published OTEL page. |

## The three findings that survived verification

**`onMessageReady` is not the streaming path.** It is the non-streaming auto-send convenience: return a string and the SDK sends one frame with `last: true`. Streaming happens through `VoiceChannel.sendStreamingResponse()`, a public method taking an `AsyncIterable<string>`, doing one synchronous `ws.send` per chunk. Design a turn span around the callback and the voice half of the instrumentation measures the wrong interval. Everything on both pages follows from this.

**Not one of twelve candidates accepts a W3C `traceparent` on its streaming endpoint.** Mastra does in process, nobody does over HTTP. The SDK bundle has zero matches for `@opentelemetry`, `AsyncLocalStorage` or `traceparent`, so every generation span today comes from the AI SDK running in this process, and `gen_ai.client.operation.time_to_first_chunk` is a string inside that package rather than anything Twilio ships. Any out-of-process migration produces two disconnected trees and deletes that instrument.

**Requirement 2 is voice-only by construction.** The messaging callback returns `Promise<string | null | void>` with no token sink, and its `abortSignal` is optional where the voice payload's is required. A candidate that cannot stream is disqualified for voice and still eligible for SMS and chat, which is why the builder page ends with a third position rather than two.

## Two process lessons, both paid for

**Do not inline research into a workflow agent's prompt.** Round one's OTEL synthesis packed seven JSON blobs into one prompt and stalled on all six retry attempts, losing the page. Round two wrote everything to disk and passed paths; the same synthesis then completed on the first try. Prompts carry paths, not payloads.

**One of the stalled attempts still did the work.** It left `.otel-check/` in the repo root, nine TypeScript files that compile clean against the real 2.2.0 types, which is why the published code blocks are verified rather than written from the type declarations by eye. A stalled agent is not necessarily an agent that achieved nothing; check the filesystem before re-running it.
