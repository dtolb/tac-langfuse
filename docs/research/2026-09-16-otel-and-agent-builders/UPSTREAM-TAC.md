# Upstream TAC repo status

## Repo status

`github.com/twilio/twilio-agent-connect-typescript` is **public**, not archived, MIT licensed (`LICENSE`: "MIT License, Copyright (C) 2026, Twilio Inc."), created 2026-01-20, 14 stars / 9 forks. Default branch `main`.

**Latest release: v2.3.0, published 2026-09-11T20:35Z.** Our 2.2.0 is one minor behind. Nine releases total: 1.0.0 (2026-05-06), 1.0.1, 1.0.2, 1.0.3 (06-26), 2.0.0 (07-07), 2.0.1 (07-20), 2.1.0 (09-01 16:17), 2.2.0 (09-01 23:01), 2.3.0 (09-11). `main` HEAD is the v2.3.0 commit — no unreleased source commits.

Maintenance: active but small and bursty. Effectively two maintainers (`ryanrouleau`, `ryanrishi`) plus `xinghaohuang91`; everything lands as squashed PRs. Roughly 20 non-dependabot commits between 2026-07-01 and 2026-09-11, clustered on release days (four on 09-01, one on 09-11). 16 open PRs, half of them dependabot/Snyk. **Only 3 issues have ever been filed** (#55, #93, #94 — all open, all documentation nits). Zero-issue repos and a 3-issue history mean "no issue about X" carries very little signal here; absence of demand is not evidence of a decision.

Forward-looking signal outside the public repo: `twilio-internal/tac-s2s-ts` (private, created 2026-09-10) describes itself as "Staging repo for the TAC TypeScript SDK **voice-provider foundation** and GPT-Live port; **merges into twilio/twilio-agent-connect-typescript**". Only the repo metadata is readable, but it says a speech-to-speech provider abstraction is being staged for the voice path — the part of TAC our tracing wraps.

## Version drift, 2.2.0 → 2.3.0

**One PR, additive.** Release notes for v2.3.0 list exactly PR #96, `feat(voice): add onDtmf callback for ConversationRelay keypresses`. The maintainer's own bump note calls it "MINOR: new exported `onDtmf` API, backward compatible."

What it changes in the voice/ConversationRelay path, from the commit message and the export barrel:

- Adds `DtmfMessageSchema` to the inbound `WebSocketMessageSchema` union. In 2.2.0 a `dtmf` frame **fails validation and is dropped with a debug log**; in 2.3.0 it dispatches.
- New exported types `DtmfEvent`, `DtmfHandler`; registration via `voiceChannel.onDtmf(handler)` or `on('dtmf', handler)`.
- **The one structural change that touches existing code paths:** the conversation-init block was extracted out of the `prompt` case into a shared `ensureConversation()` closure, so a keypress initializes a conversation the same way a prompt does. On the DTMF path an init failure is logged rather than thrown (handler still fires, with `conversationId`/`session` undefined). Nothing about the `prompt` path's behavior changed.

Nothing else touching callbacks, channels, tools, or logging moved. Verified against the shipped bundle: `dist/index.js` and `dist/index.d.ts` of our 2.2.0 contain **zero** occurrences of `onDtmf`. So a page showing 2.2.0-shaped code is still accurate for 2.3.0 with one caveat to state: DTMF keypresses are silently dropped in 2.2.0 and become a first-class callback in 2.3.0, and the voice init sequence was refactored (behavior-preserving) around it.

Earlier drift worth knowing if a page implies it: 2.1.0/2.2.0 (both 09-01) brought outbound Calls API passthrough + call events/AMD (#85), `perf(voice): start conversation lookup on setup, not first prompt` (#90), `perf(memory): skip query expansion for once-mode recall` (#89), and base-path support in `TWILIO_VOICE_PUBLIC_DOMAIN` (#87). Those are in our 2.2.0.

## Issue/PR search: opentelemetry, otel, tracing, telemetry, observability, metrics, span, langfuse, datadog

Searched each keyword across issues **and** PRs (`gh search issues --include-prs`), plus a semantic `search_issues` pass:

- **opentelemetry — 0 hits. otel — 0. tracing — 0. metrics — 0. span — 0. langfuse — 0. datadog — 0.** Stated explicitly: there is no issue or PR in this repository that mentions OpenTelemetry, tracing, spans, metrics, Langfuse, or Datadog, in any state.
- **telemetry — exactly one hit: PR #95 "Add product analytics", OPEN, opened 2026-09-10 by `ryanrishi`, +456/−3.** This is **inbound vendor telemetry, not consumer observability.** It adds `@segment/analytics-node` and `packages/core/src/lib/analytics.ts`, emitting `Conversation Started`, `Conversation Ended`, `Message Received`, `Response Sent`, `Websocket Connected`, `Websocket Disconnected`, `Voice Interrupt` to Twilio, each carrying account SID, channel, conversation ID, SDK version and package name. Opt-out via `TAC_ANALYTICS_DISABLED=true`. `trackEvent` / `shutdownAnalytics` are exported but tagged `@internal` so they are deliberately excluded from the published reference — i.e. explicitly *not* an extension point for us. Batched and flushed on an interval; `TAC.shutdown()` flushes. It also refactors `MessagingChannel.sendResponse()` into a template method delegating to a new `doSendResponse()` — that is the one thing in #95 that would touch a subclass, if it merges.
- **observability — 2 incidental hits**, both merged and both only using the word in prose: #80 `fix: surface participant reconciliation failures on inbound messages`, #7 `refactor(memory): Accept storeId in MemoryClient constructor`. Neither adds an observability facility.

## Documented observability story

**None.** Enumerated concretely:

- `README.md` (245 lines): grep for observab|telemetr|tracing|trace|otel|opentelemetry|langfuse|datadog|metric|log|pino returns **zero** matches other than the word "Logo" in the header image and the tagline. No logging section, no observability section.
- No `docs/` directory in the repo. The only "docs" are TypeDoc output published to GitHub Pages by `.github/workflows/docs.yml`.
- `getting_started/README.md`: **zero** mentions of logging, monitoring, or a log level.
- 13 examples under `getting_started/examples/`. None configures a logger, and none touches tracing. `openai/src/index.ts` and `relay-only/src/index.ts` use bare `console.log`. The closest thing to guidance is `getting_started/examples/openai/README.md` line 169, a "next steps" bullet: "**Monitoring**: Add logging and metrics for production debugging" — an instruction to the reader with no pattern attached.
- Twilio's hosted docs (`twilio.com/docs/conversations/agent-connect`, sections: Quickstart, Add TAC to your agent, AWS integration, Microsoft Foundry integration, TAC overview, Core concepts, Channels, Troubleshooting) do not mention observability, tracing, OpenTelemetry, telemetry, metrics, logging, or a custom logger.
- Confirmed in the shipped artifact: our `node_modules/twilio-agent-connect@2.2.0` `dist/index.js` and `dist/index.d.ts` contain **0** occurrences of `opentelemetry`. TAC emits no spans and has no hook for a tracer.

## The Logger abstraction

There is an injection point, but it is a pino coupling, not an abstraction, and it is undocumented.

- `packages/core/src/lib/logger.ts` defines `export type Logger = pino.Logger` — the *whole* type. Doc comment: "Logger type that can be either Pino logger or Fastify's logger" (Fastify's logger is pino, so that is one option, not two). Present verbatim in our 2.2.0 `dist/index.d.ts` line 2544.
- `createLogger({level?, name?})` builds a pino instance with `level` from `options.level ?? process.env.TWILIO_LOG_LEVEL ?? 'info'` and installs `hooks: { logMethod: piiLogMethod }`, which runs every string and plain-object argument through `scrubObject` from `packages/core/src/util/log-redaction.ts`.
- **`TACOptions.logger?: Logger` is the supported-by-existence extension point** (`packages/core/src/lib/tac.ts`: `const finalLogger = options.logger ?? createLogger({ name: 'tac' })`). It is exported and non-`@internal`, so it appears in the reference — **but `TACOptions` carries no TSDoc comment at all**, so the published reference shows two bare fields with no explanation of what supplying a logger means or what contract it must satisfy. No example anywhere uses it.
- Practical constraint on a custom sink: because the type is `pino.Logger` and not a narrow interface, anything passed in must satisfy the full pino surface — in particular `.child({...})`, which TAC calls constantly (`tac.logger.child({ component: 'conversation' })`, `'memory'`, `'knowledge'`, `'cintel'`, and `BaseChannel` does `tac.logger.child({ component: 'channel' })`). A pluggable sink is therefore achieved the pino way — pino transports/streams — not by implementing an interface. **There is no official pattern for structured or pluggable log sinks documented anywhere**, and note that a caller-supplied logger *bypasses the PII-scrubbing `logMethod` hook* unless the caller installs it themselves; nothing in the repo says so.
- Redaction helpers `maskPhone`, `maskEmail`, `maskAddress`, `scrubPii`, `scrubObject`, `redactTwimlParameters` are exported public API. PR #16 removed `pino-pretty` from library deps; PR #10 `fix(core): Remove PII from log output` is where the hook came from. Also `BaseClient` logs 4xx as warn and 5xx/network as error via interceptors (upstream `CLAUDE.md`), and clients/channels take an optional `logger?: Logger` constructor arg.
- Undocumented knob worth recording: **`TWILIO_LOG_LEVEL` is read by `createLogger` but appears in no documentation** — not `README.md`, not `getting_started/README.md`, not `getting_started/examples/.env.example` (which has zero log/analytics entries).

## Roadmap, discussions, maintainer statements on telemetry

- **GitHub Discussions is disabled** on the repo (`hasDiscussionsEnabled: false`, 0 discussions). There is no forum where a maintainer statement could live.
- No roadmap file, no CHANGELOG. `DEVELOPMENT.md` describes releases as `npm version <major|minor|patch>` + tag + "Generate release notes".
- The only maintainer statement on telemetry of any kind is PR #95's body: usage analytics flowing *to Twilio*, "No PII, message content, transcripts, or phone numbers are collected", failures swallowed, `@internal` tagging so the API stays clean. **No maintainer has stated a position on consumer-facing tracing or OpenTelemetry anywhere I could reach.**

## Callbacks and hook surface: public API, or merely exported?

**Merely exported, plus a semver habit. There are no stability guarantees.**

Evidence for "public-ish":
- `MessageReadyCallback`, `InterruptCallback`, `ConversationEndedCallback` are exported types under the TSDoc header "Callback function signatures for TAC events", and appear in the 2.2.0 `dist/index.d.ts` export list. Voice handler types `InboundCallTwimlHandler`, `CallStatusHandler`, `AmdHandler`, `RecordingHandler`, `StreamTask` (and 2.3.0's `DtmfEvent`/`DtmfHandler`) likewise.
- `typedoc.json` sets `excludeInternal: true` / `excludePrivate: true`, and upstream `CLAUDE.md` states the convention explicitly: "**TSDoc comments are published documentation**… Tag internal-facing public members (ones consumers shouldn't call) with `@internal`". So *not* being `@internal` is a deliberate signal that a member is consumer-facing. Our callbacks are not `@internal`.
- `tests/exports.test.ts` pins the presence of the top-level classes (`TAC`, channels, clients, `TACTool`, `defineTool`, tool creators, `TACServer`) — a thin export-surface tripwire. It asserts nothing about the callback *shapes*.
- Version discipline exists in practice: PR #96's own note reasons in semver terms ("MINOR: new exported onDtmf API, backward compatible"), and 2.0.0 was a real major.

Evidence against treating it as a contract:
- `CONTRIBUTING.md` contains **no** API-stability, semver, support-window, or deprecation-policy language (grep for stabil|semver|breaking|public api|deprecat returns only "Twilio Support" and version-reporting bug-template lines). Neither does `README.md`, `CLAUDE.md`, or `DEVELOPMENT.md`.
- No `@public`/`@stable`/`@experimental` tags in use; the only tag in play is `@internal`.
- The repo went 1.x → 2.x in two months and is a 14-star SDK at 2.3.0 in its fifth month, with a private staging repo openly aimed at reworking the voice-provider layer.

**Conclusion for us:** a wrapper over `onMessageReady` / `onInterrupt` / `onConversationEnded` / the voice handlers is built on *intentionally exported, published-in-the-reference* surface — the closest thing to supported that this SDK offers — but it is an unwritten contract. It is a reasonable bet, not a supported integration, and the voice path is the least safe part of it given `tac-s2s-ts`.

## Documented artifact vs shipped bundle: divergences

1. **The API reference the README points at does not exist.** `README.md` line ~181 links "**[API Reference](https://twilio.github.io/twilio-agent-connect-typescript/)** — Full API documentation generated from the source". That URL returns **HTTP 404**; the body served is a Twilio-wide org redirect stub ("Autogenerated docs have moved to https://twilio.com/docs/libraries/reference"). `/2.3.0/` also 404s. This is exactly open issue **#93 "API reference link in README is broken"** (2026-09-08, still open). Consequence for this research: the "is it in the published reference?" test I used had to be evaluated from `typedoc.json` + `@internal` tags in source, because the rendered site is unreachable.
2. **`TWILIO_LOG_LEVEL` is shipped and functional but documented nowhere** (see Logger section). The bundle wins: the knob works.
3. **`Logger`'s doc comment overstates the abstraction** — "can be either Pino logger or Fastify's logger" reads as pluggability; the type is `pino.Logger` and Fastify's logger *is* pino. No divergence in behavior, just a comment that invites the wrong inference.
4. **PR #95's analytics are not in 2.2.0** — confirmed, `dist/index.js` has 0 occurrences of `trackEvent`/`TAC_ANALYTICS`. Any doc or blog describing TAC as emitting usage analytics is describing an unmerged PR. If #95 lands, `TAC_ANALYTICS_DISABLED=true` becomes a config knob we should set, and its Segment egress is a new outbound network dependency in the container.
5. Open issue **#94** reports Twilio's hosted Memory auto-retrieval docs using a config option (`autoRetrieveMemory`-shaped) that does not exist in the SDK — a standing example that the hosted docs run ahead of / apart from the shipped code. Trust the bundle.

## Citations

- https://github.com/twilio/twilio-agent-connect-typescript
- https://github.com/twilio/twilio-agent-connect-typescript/releases/tag/v2.3.0
- https://github.com/twilio/twilio-agent-connect-typescript/releases
- https://github.com/twilio/twilio-agent-connect-typescript/pull/96
- https://github.com/twilio/twilio-agent-connect-typescript/pull/95
- https://github.com/twilio/twilio-agent-connect-typescript/pull/80
- https://github.com/twilio/twilio-agent-connect-typescript/pull/10
- https://github.com/twilio/twilio-agent-connect-typescript/pull/16
- https://github.com/twilio/twilio-agent-connect-typescript/issues/93
- https://github.com/twilio/twilio-agent-connect-typescript/issues/94
- https://github.com/twilio/twilio-agent-connect-typescript/issues/55
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/lib/logger.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/lib/tac.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/index.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/packages/core/src/util/log-redaction.ts
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/typedoc.json
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/CLAUDE.md
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/CONTRIBUTING.md
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/DEVELOPMENT.md
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/README.md
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/getting_started/examples/openai/README.md
- https://raw.githubusercontent.com/twilio/twilio-agent-connect-typescript/main/tests/exports.test.ts
- https://twilio.github.io/twilio-agent-connect-typescript/
- https://www.twilio.com/docs/conversations/agent-connect
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts#L2542-2548
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/dist/index.d.ts#L3012
- file:///Users/dtolbert/code/tac-langfuse/node_modules/twilio-agent-connect/package.json#L3

## Unverified

- The rendered TypeDoc API reference could not be inspected — https://twilio.github.io/twilio-agent-connect-typescript/ returns HTTP 404 and serves a Twilio org-wide redirect stub. Claims about what does or does not appear in the published reference are inferred from typedoc.json (excludeInternal/excludePrivate) plus @internal tags in source, not from the rendered site.
- The private staging repo twilio-internal/tac-s2s-ts is inaccessible; the claim that a voice-provider/speech-to-speech refactor is headed for the public TypeScript SDK rests solely on that repo's public name and description in search results, not on any readable code, plan, or maintainer statement.
- Twilio's hosted TAC documentation was read via a single WebFetch of the landing page, which summarized the section list. Individual subpages (Core concepts, Channels, Troubleshooting, Add TAC to your agent) were not fetched one by one, so a logging or observability paragraph buried in a subpage cannot be fully ruled out.
- GitHub keyword search over issues/PRs matches titles and bodies; a mention of OpenTelemetry buried only in a PR review comment or a commit diff would not appear in those results. Code search across the repo for 'opentelemetry' was not run as a separate pass, though the shipped 2.2.0 bundle was grepped and contains zero occurrences.
- Whether a caller-supplied TACOptions.logger actually bypasses the PII-scrubbing logMethod hook was reasoned from reading createLogger and the tac.ts assignment, not exercised at runtime.
- Whether the maintainers would consider a change to the callback signatures a breaking change is inferred from PR #96's semver note and the 1.x-to-2.x history; no written policy exists and no maintainer was asked.
