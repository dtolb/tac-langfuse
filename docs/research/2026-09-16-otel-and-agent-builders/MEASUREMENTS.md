# Quotable measurements and their caveats

# Quotable measured numbers, with mandatory caveats

Source dates: everything below is 2026-09-15 unless noted. All latency figures come from ClickHouse `events_full` (Langfuse v4 `events_only` disables the read API), or from the obs bus.

## 1. Latency investigation, 2026-09-15

| Value | Measures | Sample | Caveat that must travel with it |
|---|---|---|---|
| **84 ms** | Total framework/preamble cost before the model stream starts (`prompt.fetch` 41 ms ∥ `memory.recall` 79 ms, run concurrently) | one worst-case turn, attributed to ±1 ms; range **0–84 ms** across every turn measured | It is the *ceiling*, not a mean. Must be quoted with "everything else is model time" or it reads as a total-latency claim. Supersedes T9's 46 ms preamble figure (HANDOFF:2030) — don't quote both as if they measure the same thing. |
| **33 generations** | Sample size for the whole `time_to_first_chunk` conclusion | 33 | Single day, single caller, one model. Not a benchmark. |
| **`gen_ai.client.operation.time_to_first_chunk` accounts for the generation span almost exactly; the residual is streaming output, not overhead** | Where latency lives | 33 generations | Attribute is **in seconds**, native to the AI SDK. Siblings: `…operation.duration`, `…time_per_output_chunk`. |
| **6214 ms** | Worst turn of the 19:33 UTC call, `turn.ttft_ms`, fully attributed with no residual: 84 preamble + 3838 gen-1 first chunk (cold cache, 2520 input tokens) + 641 tool-arg streaming + 1018 `search_knowledge` + 7 + 625 gen-2 first chunk = 6213 | 1 turn | This is a **cold-cache, two-generation, tool-calling turn** — the worst case, and it is the *first* turn of a conversation. Span durations do **not** sum to the turn (the tool fires as soon as args parse and overlaps generation 1); read timestamps, not durations. |
| **Tool execution: `lookup_order` 1 ms, `search_knowledge` 417–1018 ms, `handoff` 266 ms** | Tool round-trip cost | small, single day; `handoff` measured once at 266 ms here and **553 ms** at T14b (HANDOFF:1434) | Two different `handoff` numbers exist in the doc — cite which. `search_knowledge` hits a real Twilio Knowledge Base, so it is network-bound. |
| **Tool-free turn 586 ms; tool turns 1282–1433 ms** at healthy model speed | The structural cost of a tool cycle | handful of turns | Nothing is spoken while a tool runs — a design choice, not a defect. **586–801 ms is the only legitimate "healthy" baseline** in this repo. |
| **Turns 2+ report `input_cached_tokens` 1536–2560 and run 0.51–0.71 s** | Prompt-cache effect | one call (19:33), 6 follow-on turns | The cache absorbs the memory bloat on turns 2+, so the entire cost lands on **turn 1 — the turn a caller forms an impression on**. Quoting 0.51–0.71 s without "turn 2 onward, cache-warm" is the single most misleading thing available on this page. |
| **Prompt budget, generation 1 of the 19:33 call: base voice prompt 4087 chars / 33%, injected memory 4412 / 35%, tool definitions (5) 4035 / 32%** | System-prompt composition | 1 generation | ⚠ These are `chars ÷ 4` proportions. The tokenizer reported **2520** input tokens where chars÷4 predicts ~3132 — it **overestimates by ~24%**. **Trust the shares, not absolute token counts.** |
| **Per-tool definition cost: `search_knowledge` 1244, `handoff` 967, `end_call` 773, `get_store_hours` 529, `lookup_order` 512 chars (4035 total)** | Paid on every turn | 1 measurement | `search_knowledge`'s long description is **load-bearing** — score cannot gate it (see §5), so it is not free to trim. |
| **`model_parameters` is `{}` on all 33 generations; reasoning effort is never sent** | An untried lever | 33 | ⚠ **This is a hypothesis, not a measurement.** No reasoning-token attribute exists on the span at all, so the traces cannot say whether reasoning costs time. Never present "reasoning effort" as a quantified win. |

**Ranked levers, best first** (HANDOFF:1866–1878), quotable as-is:
1. **Cap or dedupe the memory block** — largest, entirely ours, actively worsening, improves answer quality as well as TTFT.
2. **Prune tool definitions** — 4035 chars for five tools, paid every turn. Constrained by `search_knowledge`'s load-bearing description.
3. **Try `reasoning_effort: 'low'` for voice** — needs a `providerOptions` path built first. Unmeasured.
4. **Speak a filler while a tool runs**, if tool turns should feel like tool-free turns.

## 2. The memory block and prompt-cache behaviour

| Value | Measures | Sample | Caveat |
|---|---|---|---|
| **+88% in one day (2341 → 4412 chars)** | `memory.recall` output size, same caller | 5 conversations in one day | **Not monotonic** — 15:52 (1837) dips below 14:01 (2341), so the Orchestrator **rewrites** rather than only appending. "Grows per call" is wrong; "net +88% in a day" is right. |
| Series: 14:01 voice **2341** · 15:47 bench **0** · 15:52 sms **1837** · 17:56 sms+voice **3303** (identical) · 19:33 voice **4412** | Memory-block size by conversation | 5, all same caller | The bench sends no memory payload, hence 0 — not a measurement of memory. The identical 3303 across sms and voice is the evidence that recall is **caller-scoped, not channel-scoped**. |
| **6.3× (696 chars at T14, 2026-09-14 → 4412 chars, 2026-09-15)** | Longest available growth baseline | 2 points, **different conversations** | ⚠ The 696-char T14 figure was an **SMS** conversation and the file does not record its caller. Treat 6.3× as a **scale reference only**, never as a same-caller series. |
| **52% of the system prompt** | Memory's share | 1 generation | ⚠ **Two different denominators exist in this repo and they disagree.** 4412 / (4087 base + 4412 memory) = 52%; 4412 / (base + memory + 4035 tool defs) = **35%**. A public page must state which. |
| **`memory-compose.ts` caps nothing** | Code fact, verified | — | `RECALL_SECTIONS` renders whatever Recall returns; the only cap in the file, `MAX_CACHED_PROFILES`, bounds the profile *cache* and is unrelated to prompt size. Any bound must come from Orchestrator capture rules or be added there. |
| **Content is degrading: `4721` vs `A4721` contradicting inside one observation; four Past Conversation Summaries recounting the same call** | Quality, not latency | 1 prompt | The verbatim quote in HANDOFF:1819–1822 is **derived from a real caller transcript — do not reproduce it publicly.** Paraphrase the failure mode. |

## 3. Voice timeline (tiled spans), proven on a real call 2026-09-15

| Value | Measures | Sample | Caveat |
|---|---|---|---|
| **Before: 57.5 s call, 12.2 s of spans, 45.3 s of gap** (trace `d2e680b5…`, 22:43 UTC, 6 turns) | The problem being solved | 1 call | Pre-fix state. Only quote alongside the after-figure. |
| **After: 42.7 s root (42675 ms) fully covered, 86 observations, 6 turns** (trace `a046b1cd…`, 23:04 UTC) | Coverage | **1 call** | One call, one caller, one direction. Everything in this section rests on a single sample. |
| **The gap between every consecutive root child is 0 ms** | Tiling coverage | 1 call, 11 boundaries | Two residuals, both explainable: **head −1 ms** (turn 1 back-dated because `promptAt` is captured before the root span is created lazily — the correct sign) and **tail 2394 ms** (last `last: true` → socket close: the final reply still playing plus hangup, which nothing we own can see inside). |
| **`caller.turn` = 27622 ms of 42675 = 65% of the call** | Where the call time goes | 1 call | ⚠ **`caller.turn` is a BLEND and must never be presented as caller speech**: bot TTS playback + caller speech + ASR endpointing + TAC's memory Recall on turn 1 (`handlePromptMessage` awaits `retrieveMemoryIfEnabled` before our handler runs, and voice uses `memoryMode: 'once'`, so a Conversation Orchestrator round-trip sits inside it). |
| **`tts.send` 150–804 ms per turn** | Our token-streaming cost per turn | 6 turns, 1 call | This is what proves the 65% is *not* our streaming. |
| Per-turn: `turn.voice` 3181 / 1288 / 1594 / 2064 / 884 / 3649 ms; ttfa 2667 / 484 / 1201 / 1655 / 547 / 3499; `caller.turn` 4190 / 2849 / 6824 / 6265 / 7494 ms | The waterfall | 1 call | Root metadata: `turns.count=6 turns.aborted=0 caller.turn_total_ms=27622 turn.ttfa_p50_ms=1201 turn.ttfa_max_ms=3499 closedBecause=ended`. |
| **`turn.ttfa_ms` landed within 0–3 ms of `turn.ttft_ms` on all six turns** (2667/2664, 484/481, 1201/1201, 1655/1654, 547/546, 3499/3498) | Whether anything queues between model and socket | 6 turns, 1 call | ⚠ **Do not present `ttfa` as time-to-first-audio.** It is a server-side proxy: the anchor is the first non-empty delta and TAC's `sendStreamingResponse` does `ws.send` synchronously in the same `for await` iteration. It proves a **useful negative** (nothing queues) and is blind to TTS and playback — the part a caller actually hears. |
| **The interrupt path is NOT proven on real traffic** | — | both real calls have `turns.aborted=0`, no `tts.interrupted` | `durationUntilInterruptMs` on a live barge-in has only been seen from the test suite and the diagnostic. Treat that branch as unverified. (Note: HANDOFF:2079 elsewhere claims "barge-in on real audio" among verified items, and T13/T14 record barge-ins at 230/281/346/459/462/782/1121/1601 ms — the unverified thing is specifically the **new tiled instrumentation's** interrupt branch.) |
| **23 tests over real spans** (`tests/voice-telemetry.test.ts`) | Test coverage of the instrumentation | — | The harness needs an `AsyncLocalStorage` context manager and a local traceparent propagator — with a bare `BasicTracerProvider`, `context.with` is a no-op and the first run reported **six trace ids for one call**. The harness cannot exercise `LangfuseSpanProcessor`'s filters, so the live run is the real proof. |

## 4. POISONED — every figure tracing to the T15 close-out call (trace `a01d08e1…`, 17:56:46 UTC, 2026-09-15)

The call landed inside a measured **~2-hour upstream slow patch, 2–5× worse than surrounding windows**. Never use any of it as a latency baseline.

- **`turn.ttft_ms` of 6934 / 7723 / 6850 / 6047 ms** — the worst on record in this repo (HANDOFF:1846).
- **The "6.0–7.7 s TTFTs"** rounding of the same four numbers, as it appears in CLAUDE.md:136.
- **Model TTFT per generation 3.71, 4.74, 2.07, 2.26, 4.39, 4.74, 1.28, 2.90, 2.79 s** for the 17:56–17:57 window (HANDOFF:1839).
- **The tool-free SMS turn at 17:56:11 that took 3835 ms** — this is the *diagnostic* that isolates the slowdown from tool structure (elsewhere tool-free turns are 586–801 ms), so it is quotable **as evidence of the slow window**, never as a latency figure.
- Healthy comparison windows, safe to quote: 14:01 → 1.61, 0.74, 1.02, 0.59, 0.80, 0.74, 0.70 s; 15:47–15:55 → 2.00, 0.80, 1.25, 1.21, 0.54, 0.40, 0.77, 0.82, 0.69, 0.58 s; 19:33–19:34 → 3.83 (cold turn 1), then 0.63, 0.58, 0.51, 0.57, 0.71, 0.55 s.

**Why "not us" is provable, on three counts** (all quotable): container `ef371f7fbd13` served both the fast 15:52 and the slow 17:56 call, so it is not container cold start; prompt v6 and `model_parameters` were identical throughout; and the tool-free turn isolates it from tool-cycle structure.

**What the T15 call REMAINS valid for**: routing, `/ws` upgrade, trace grouping, handoff — none of which is timing-dependent. Its non-latency figures are safe: 4 turns in one trace, 4 tools (`lookup_order`, `search_knowledge`, `handoff`, `end_call`), 72 s call, a human answered, 1 inbound SMS → 1 reply.

Also poisoned-adjacent, from the same session: `sessionDurationSeconds: "34"`, `handoff` 553 ms, per-turn ttft 2472 / 2411 / 801 / 2257 ms and totals 2712 / 2826 / 1156 / 2484 ms are from the **T14b** call (HANDOFF:1434), a *different, earlier* call that is NOT in the slow window — do not merge the two.

## 5. Other safe-with-caveat numbers a page might want

- **`pnpm typecheck` → 0; `pnpm test` → 327 passed, 19 files** (TS 7.0.2). Repo state as of T15 (HANDOFF:60-61).
- **Extraction latency ~2 seconds** after a conversation closes; conversation closes **5m36s from creation** (`statusTimeouts.closed: 5`). One measurement, SMS, 2026-09-14 (HANDOFF:99-101).
- **Handoff extraction: reached CLOSED in 32 s and wrote 3 observations 3 s later**, even with status callbacks cleared. One measurement (HANDOFF:2093).
- **SSE held 184.7 s with 15 s heartbeats and no drop** through Traefik; it ended only because the agent was stopped, "and the number was not round" (HANDOFF:1621). Proves no `respondingTimeouts` on this Traefik — a property of *this box*, not of Traefik generally.
- **Clean SIGTERM: drains TAC, force-closes the held-open SSE request, exits 0 in under a second against a 60 s `stop_grace_period`.** ⚠ The **45 s TAC drain is NOT proven** — it only engages when TAC has a live WebSocket, i.e. needs a SIGTERM *mid-call*. A fast clean exit with no call in flight tells you nothing about it.
- **`TAC_SHUTDOWN_TIMEOUT_MS = 45_000` vs Docker's default `stop_grace_period` of 10 s** — hence `stop_grace_period: 60s`, or SIGKILL lands 35 s before the only telemetry flush.
- **Reboot behaviour, measured over two full Colima cycles**: on a VM stop the agent exits **0** and Next exits **143**, so `on-failure` left the agent down and resurrected `web`. Stack runs `restart: "no"` deliberately.
- **Knowledge-base scores are not comparable across queries**: in-scope "What is your return window?" → 1.0 / 0.54 / 0.53; out-of-scope order query → **0.816** / 0.468 / 0.38, i.e. an out-of-scope query outscores the in-scope query's own second hit. This is why no threshold can gate `search_knowledge` and its description is load-bearing.
- **Verbosity fix, prompt v5**: opening turn went from **455 characters** to **310 / 231 / 265 / 247 / 214**, and barge-ins moved from 459/346 ms out to 462 / 782 / 1601 / 1121 ms. "Better rather than perfect — still above one or two sentences." One call before, one after.
- **Profile cache**: uncached `profileMs` 76 / 623 / 113 / 134 ms per turn → cached **82 then 0**. Bounded at 200 entries, negative results cached too. ⚠ The first verification attempt was a **false negative** because the agent process had started 53 minutes before the fix was committed — Node does not hot-reload, Langfuse prompt edits do (~20 s TTL).
- **T13 voice, warm turns 500–800 ms**, ttft 2405 → 1077 → 1489 → 509 → 463 ms as the prompt cache warmed. ⚠ The fast 463–509 ms turns were **single-step, no-tool** turns; not comparable to tool turns.
- **T12 SMS: ttft 1599 ms / total 1979 ms (2 steps, 1 tool); 1661 / 1766 ms (1 step, 0 tools)**, 2026-09-11. ⚠ SMS TTFT (1599 ms) came in *lower* than the bench minutes earlier on the same model and prompt (**2189–2624 ms**) — unexplained and never chased.
- **Spike S1's 1112 ms** — HANDOFF:2033 says compare to it "only carefully; that was a single-step turn."
- **`invoke_agent` parents to the TURN span, not to `llm.stream`.** Earlier revisions of HANDOFF drew the waterfall as `llm.stream > invoke_agent` and that is **wrong** — `llm.stream` is a timer running alongside the model call. Don't publish the wrong tree.
- **One identity allows 10 concurrent registrations**; the 11th evicts the oldest.

## 6. "Gaps and honest limits" — the unproven/unmeasured claims, close to verbatim (HANDOFF:2027–2180)

Reusable phrasings:

- **Latency is no longer deferred.** T9's finding (preamble 46 ms; cost is in sequential model round-trips, not `runTurn`) was re-confirmed with the native `time_to_first_chunk` attribute. What T9 could not see is that the dominant term is now the **cold first turn** against a memory block grown to 52% of the system prompt.
- **`gpt-5.4-mini` is a reasoning model and silently ignores `temperature`.** The AI SDK warns twice per turn; `temperature` was dropped from compiled defaults, but live Langfuse prompt v2 still sets `0.4` — an operator edit, deliberately not policed in code.
- **PII does reach Langfuse.** Our own spans and events are scrubbed (verified `+1***4567`), but the AI SDK's model spans carry the full prompt and completion. "Do not describe this app as keeping PII out of Langfuse."
- **PII also reaches the memory store.** The profile's traits are a phone number; extracted observations are prose derived from the transcript. `obs/pii.ts` scrubs log lines and obs payloads — **not** tool results or the memory store. `builtin-tools.ts` projects communications down and drops `recipients`; the store itself is Twilio-side and out of our control.
- **The T14b transcript route is a new PII surface and is deliberately unscrubbed** — the human agent needs the caller's real words. The caller's number is masked for display; the transcript is verbatim by necessity.
- **t0 is our first observation, not STT arrival.** Un-measurable upstream: WS frame parse, `startStreamTask`, TAC's `promptQueues` serialisation. `turn.ttft_ms` is turn-relative, `turn.ttft_model_ms` model-relative; **neither includes the upstream gap.**
- **TTS first byte and playback end are NOT measurable from here.** ConversationRelay exposes neither (`tokens-played` appears in the attribute table and in no websocket-message reference, and TAC drops unrecognised inbound frames before dispatch). The residual surfaces as the trailing 2394 ms and as the bulk of every `caller.turn`. Getting the real number needs Voice Insights or Media Streams `mark` events — both out of scope.
- **`caller.turn` is a BLEND and must never be presented as caller speech.** Measured at 65% of a real call.
- **The live barge-in path is unverified.** Proven only by `tests/voice-telemetry.test.ts` and `scripts/verify-telemetry.ts`; both real calls have `turns.aborted=0`. One call where somebody talks over the agent closes it.
- **Langfuse v4 `events_only` has no public read API for traces.** `/api/public/traces`, `/observations`, `/metrics/daily` all 404 — a 404 meaning *disabled*, not *no data*. Prompts read fine via `/api/public/v2/prompts`. Trace verification is a **UI check**, never an API assertion.
- **History is process-local and dies with the container** — by decision. A `node --watch` restart drops every conversation mid-call; a two-instance deploy would not share them.
- **What the bench does NOT prove.** It exercises `runTurn` end to end with no Twilio, "which is real but bounded." Not covered: webhook signature validation, ConversationRelay STT/TTS latency, barge-in on a live call, TAC memory retrieval, `session.metadata` surviving a real conversation, orchestrated-mode memory writes, Studio handoff. Its abort path is a closed browser tab — "a plausible stand-in for a barge-in and not the same thing."
- **The TAC-free claim is stronger than the architecture test.** `tests/architecture.test.ts` checks import *strings*, which a file can satisfy by not having got round to importing TAC. The runtime check was run (module moved aside, agent booted, `/health` 200, a complete 25-token turn with a real tool call and 2 steps, zero resolution errors) — but re-running it post-T12 "is the one outstanding check that costs nothing."
- **Live coverage: ten SMS turns and five calls (24 voice turns total).** Still unexercised: the 45 s shutdown drain (needs SIGTERM during a call) and a `/ws` signature rejection (invisible by construction).
- **Screen-pop correlation is caller-number plus most-recent** — two simultaneous calls from one number would cross. Acceptable for a demo, stated rather than hidden.
- **The repo's 7-day supply-chain guard is not enforced.** pnpm 11.8 does not read `minimum-release-age` from `.npmrc`; `pnpm-workspace.yaml` has no `minimumReleaseAge`. Reported, not policed.
- **The demo's memory story needs TWO conversations and a five-minute gap** — extraction is post-conversation only. "A demo script that texts once and expects the agent to remember will fail, correctly."
- **A corrected claim worth not re-publishing**: HANDOFF used to say that without the `X-Forwarded-Proto = https` Traefik label "every webhook 403s — a silent, total outage." **That is false on this box** — `forwardedheaders.trustedips=172.16.0.0/12` covers the Caddy that terminates TLS, so the genuine header is preserved, and TAC's `getForwardedProto` defaults to https when absent. Keep the label as defence in depth; don't publish the outage claim.

## 7. Do NOT put on a public page

**Security disclosure (the strongest reason to withhold):** HANDOFF:2137–2180 names **four unauthenticated, permanently addressable endpoints on a stable, guessable public host** — `POST /api/voice/token` (mints a real Twilio Voice AccessToken to an anonymous caller, verified live), `POST /api/bench/turn` (spends the OpenAI key, unmetered), `POST /api/dev/emit-turn` (fabricates observability events), `GET /health` (lists names of unset variables). Publishing this is publishing an attack recipe against a live host.

Also inappropriate:
- **The public host and app name** — `northwind.twilio.dtolb.com`, `APP_NAME=northwind`, the `*.twilio.dtolb.com` pattern (HANDOFF:65, 170-171, 1632, 2141).
- **The caller's phone number** `+1919…` (HANDOFF:1790, 1697) and the scrub example `+1***4567`.
- **Twilio infrastructure IP** `54.174.70.237` (HANDOFF:1679).
- **Identifiers**: trace ids (`1c835f9d…`, `a01d08e1…`, `448f3c4b…`, `a046b1cd…`, `d2e680b5…`), span id `73cc06285891f6a0`, container hash `ef371f7fbd13`, conversation id `conv_conversation_01m28kmbk4f7dawyafmmsehn36` (HANDOFF:110), `CLIENT_IDENTITY` / `client:browser_agent`.
- **Credentials in the runnable snippets** — `--user clickhouse --password clickhouse` appears in every ClickHouse query block (HANDOFF:1741, 1888, 1902, 1917, 1717). Strip before publishing any of those commands.
- **Cost/pricing**: `$0.001388` per SMS conversation trace (HANDOFF:389).
- **Model identity**: `gpt-5.4-mini`, prompt versions `demo-agent-text v3` / `demo-agent-voice v5` / `v6`, `TS 7.0.2`, `pnpm 11.8`, `TAC 2.2.0` — check each against what is publicly announced before naming it.
- **The verbatim memory-block prose** at HANDOFF:1819-1822 — derived from a real caller transcript. Paraphrase the contradiction ("the same fact stored twice with different order numbers"), don't quote it.
- Order numbers `A4721` / `A4832` and "Northwind Traders" are fictional demo data and are fine.

## Citations

- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L79-L82
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L99-L101
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L124-L136
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L368-L418
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L804-L818
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1160-L1172
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1194-L1215
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1415-L1440
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1450-L1466
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1532-L1540
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1600-L1642
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1675-L1726
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1727-L1754
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1755-L1775
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1776-L1830
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1831-L1854
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1855-L1878
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1879-L1923
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1924-L1959
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1960-L1974
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L1975-L2026
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L2027-L2100
- file:///Users/dtolbert/code/tac-langfuse/docs/HANDOFF.md#L2137-L2180
- file:///Users/dtolbert/code/tac-langfuse/CLAUDE.md#L128-L141
- file:///Users/dtolbert/code/tac-langfuse/CLAUDE.md#L143-L155

## Unverified

- I did not re-run any ClickHouse query, call, or test — every figure above is transcribed from HANDOFF.md/CLAUDE.md, not independently re-measured.
- The 52% vs 35% memory-share discrepancy is my arithmetic on the published chars (4412/8499 = 51.9%; 4412/12534 = 35.2%). HANDOFF does not explicitly state which denominator produced '52%', so which figure the author intended is inferred.
- HANDOFF:2079 lists 'barge-in on real audio' among live-verified items while HANDOFF:2022 and 2054 say the barge-in path is unverified. I read the reconciliation as 'barge-in happened on real calls; the new tiled-span interrupt branch has not been exercised live' — but the document does not say that explicitly.
- `handoff` tool latency appears as 266 ms (HANDOFF:1780) and 553 ms (HANDOFF:1434). I could not determine whether these are the same code path measured on different calls or two different operations.
- Whether `gpt-5.4-mini`, TS 7.0.2, pnpm 11.8 and TAC 2.2.0 are publicly announced versions is not something I checked; I flagged them as needing a check rather than confirming they are unpublishable.
- I did not read `server/twilio/memory-compose.ts`, `server/agent/prompt/port.ts`, or `voice.ts` to confirm the code-fact claims (no cap, schema fields, interrupt-handler parking) — those are HANDOFF's assertions, and CLAUDE.md warns that assertive comments in this repo have been wrong before.
