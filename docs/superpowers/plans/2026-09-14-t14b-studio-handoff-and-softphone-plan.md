# T14b — Studio handoff + browser softphone: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caller who asks for a human hears one short line, the ConversationRelay session ends, the call lands on a browser softphone a person answers, and that person sees why the caller was transferred and what was already said.

**Architecture:** The model calls a `handoff` tool that only records an intent (exactly like `end_call`). After the farewell has streamed, `server/twilio/voice.ts` snapshots the transcript, delegates to TAC's `createStudioHandoffTool` to park a ready-made `{type:'end',handoffData}` frame on the session, and sends that frame — the five-line drain TAC only performs inside `sendResponse`, never inside `sendStreamingResponse`. ConversationRelay then POSTs the `<Connect action>` URL, which we repoint from TAC's own route to one we own; that route returns TwiML that either `<Redirect>`s to Studio or `<Dial>`s the browser client directly.

**Tech Stack:** Node 24 + TypeScript (`tsc --noEmit`), Fastify 5, `twilio-agent-connect@2.2.0`, `zod@4`, `vitest@5`, Next 16 + React 19 + `@gtmi/strix-react` for the softphone, `twilio@5.13.1` (new, server-side, token minting only), `@twilio/voice-sdk` (new, browser only).

**Read before starting:** `docs/superpowers/specs/2026-09-14-t14b-studio-handoff-and-softphone-design.md`. This plan implements that spec and does not restate its evidence. Where this plan disagrees with the spec, the disagreement is listed in "Seven corrections to the spec" below and this plan wins — each correction was forced by reading the repo the spec describes.

---

## Global Constraints

Every task's requirements implicitly include all of these.

- **`twilio-agent-connect` may only be imported from `server/twilio/` or `scripts/`.** `tests/architecture.test.ts` enforces it. Same rule, same prefixes, for the `twilio` package.
- **`ai` and `@ai-sdk/openai` only from `server/agent/model/`; `@langfuse/client` only from `server/agent/prompt/`.** Untouched by this task; do not widen.
- **No `console.*` anywhere in `server/` or `web/src/`.** Use the injected logger. `scripts/` is exempt.
- **`shared/` must be self-contained** — it is compiled by both tsconfig projects, may import only relative paths inside `shared/`, and may touch no Node or DOM global.
- **New HTTP routes go under `/api/`.** `APP_API_PATHS` in `shared/twilio-paths.ts` is `['/api', '/events', '/health']`, so `/api/*` is already covered by the Traefik-label architecture test and needs no compose change. A route at `/voice/relay-action` would need a new prefix in both places.
- **Nothing on the voice path may throw.** TAC swallows what escapes a handler and the caller hears silence. Every exit path either speaks or is deliberately, documented-ly silent.
- **A capability-gated route answers 503 naming the missing variable**, via `unavailable(config, feature)` from `server/config.ts` — never a 500 and never a silent 404.
- **`ToolDef` must not gain new fields.** `run-turn.ts`'s `instrument()` rebuilds a `ToolDef` field by field, copying only `name` / `description` / `input` / `requires`, so any new field is silently dropped.
- **Tool names must satisfy `TOOL_NAME_RE`** = `/^[a-z][a-z0-9_]{0,63}$/`. A name outside it is an opaque 400 from OpenAI mid-turn.
- **Integration over unit** (house convention, `feedback-tests-integration-over-unit`). Do not coverage-chase; this is a demo scaffold.
- **Commit after every task.** `pnpm typecheck && pnpm test` must be clean before each commit. Baseline at the start of this plan: **291 tests / 16 files, typecheck 0 errors**.
- **Never run `pnpm add` by hand-editing `package.json`** (`feedback-prefer-clis-for-project-config`). Use `pnpm add`.
- **`lsof -ti :8910` matches ngrok and kills the tunnel.** Use `lsof -ti :8910 -sTCP:LISTEN`.
- **Restart the agent after a code change before concluding a fix does not work.** Node does not hot-reload; Langfuse prompts do (~20 s TTL). Check `ps -p <pid> -o lstart=` against the commit time first.

---

## Seven corrections to the spec

Each was found by reading the code the spec describes, and each changes a file path or a step order.

### C1. The token route cannot live in `server/http/` — the `twilio` package is confined to `server/twilio/`

Spec §5 puts `POST /api/voice/token` (AccessToken + VoiceGrant) in `server/http/routes-handoff.ts`. `tests/architecture.test.ts` allows the `twilio` package only under `server/twilio/` or `scripts/`, so that file would fail the build.

**Resolution:** minting lives in `server/twilio/voice-token.ts` (imports `twilio`), and `server/http/routes-handoff.ts` receives a `mintToken` function injected from `server/index.ts` at the same point `bootTac` runs. A process with no Twilio credentials therefore never loads `twilio` at all, which is the same property `bootTac`'s dynamic import already buys.

### C2. Snapshot the transcript at DRAIN time, not inside the tool

Spec §4 step 1 snapshots `history.read(conversationId)` inside the tool, before delegating. But `run-turn.ts:627` appends the user+assistant pair **at the end of `runTurn`, before `done` resolves** — so at tool-execution time history does not yet contain the caller's "I want a human" line, which is the single most important line on the screen pop, nor the farewell.

**Resolution:** the tool records only the reason (a pending-intent map, exactly like `end-call.ts`). `voice.ts` composes the snapshot after `await done` and before sending the frame. This still satisfies the spec's real constraint — the snapshot is taken before the socket closes, because the socket closes *because* we send the frame.

### C3. The snapshot store must be a TAC-free module

`GET /api/handoff/context` (in `server/http/`) reads the snapshot and `server/twilio/voice.ts` writes it. If the store lived beside the tool in `server/twilio/handoff.ts`, the HTTP layer would transitively load TAC at module load, destroying the property that a credential-free process never loads the vendor.

**Resolution:** the store is `server/handoff/snapshots.ts` — no vendor imports, only types from `shared/handoff.ts`. Written by `server/twilio/voice.ts`, read by `server/http/routes-handoff.ts`.

### C4. `handleVoiceDisconnect` must NOT clear the snapshot — only the intent

Spec §6 says *"`handleVoiceDisconnect` must clear the handoff snapshot too, for the same reason it already clears the `end_call` intent."* That is right for the intent and wrong for the snapshot. The socket closes **because** we sent the handoff frame, so `webSocketDisconnected` fires seconds before a human presses answer. Clearing the snapshot there makes the screen pop reliably empty on the one path it exists for — a silent failure that would look like a broken route.

**Resolution:** disconnect clears `forgetHandoffRequest` (the intent) and leaves the snapshot. Snapshot lifetime is bounded by `HANDOFF_MAX_SNAPSHOTS` eviction.

### C5. `handoff` is named in the VOICE prompt only

Spec §5 says to name `handoff` in **both** prompts' `config.tools`. TAC's tool does branch internally and its digital branch works — but it sets the conversation `INACTIVE` and clears its status callbacks **before** the POST that can fail, and TAC contains no `'ACTIVE'` write and no inverse for `clearStatusCallbacks`. On SMS that leaves a customer whose next text reaches nothing, with no downstream repair. Sending the frame is what mitigates that failure path on **voice**; nothing mitigates it on SMS.

**Resolution:** the tool stays channel-agnostic (TAC already branches), but only `demo-agent-voice` names it. This matches the existing precedent — `end_call` is voice-only, `retrieve_profile_memory` is text-only — and the spec's own verification ladder (§9) exercises voice only. Reversing this is a one-line prompt change if a text-handoff demo is ever wanted, and Task 8 records what would have to be verified first.

### C6. `buildHandoffPayload` does not throw on a null profile

Worth recording because it changes an error path we would otherwise have written. `dist/index.js:6410` is `profileId: session.profileId ?? ""` — an unrecognised caller yields an empty-string `profileId` in the payload, not an exception. So no profile guard is needed in our tool, and the handoff works for a first-time caller.

---

### C7. The Studio flow does not receive `HandoffData` at all, so the `json_object` widget is not needed

Spec §8 makes the flow add a `set-variables` widget for `{{trigger.call.HandoffData}}` typed `json_object`, and calls that type "the load-bearing detail". That works when **Studio itself is the `<Connect action>` URL** — ConversationRelay POSTs `HandoffData` in the body and Studio surfaces it on the trigger. But §2.1 requires us to own the action route instead, so Studio is reached by a `<Redirect>`, which starts a **fresh incoming-call execution**.

Checked against Twilio's Studio documentation: the Incoming Call trigger exposes a **fixed** variable list (`{{trigger.call.*}}`, the Call resource fields — `From`, `To`, `CallSid`, `CallStatus`, geo fields). Arbitrary query-string parameters are not among them. Passing custom data into a Flow is documented for the **REST API** trigger (`{{flow.data.X}}`) and for returning to a **TwiML Redirect widget** (`{{widgets.NAME.VAR}}`) — neither is a redirect into a fresh voice trigger. So `{{trigger.call.HandoffData}}` would silently resolve to nothing.

**Resolution:** the flow does not need it. Our action route already has the parsed `HandoffData` in the POST body — it is what decides to route at all. The reason and transcript reach the browser through `GET /api/handoff/context`, correlated on the caller's number, which is exactly the mechanism spec §3.2 already designed because the `connect-call-to` widget cannot pass parameters to a client anyway. The flow therefore reduces to **Trigger(incomingCall) → connect-call-to `client:browser_agent`**, with no `set-variables` widget and no `json_object`.

This also shrinks the account change in spec §8 to a single edit: the `to` field.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `shared/handoff.ts` | **new** | `CLIENT_IDENTITY`, the three route paths, and the screen-pop types shared with `web/`. Pure data. |
| `shared/tac-tool-names.ts` | edit | Append `'handoff'` as index **2**. Indices 0 and 1 are read positionally by `builtin-tools.ts` and must not move. |
| `server/handoff/snapshots.ts` | **new** | Bounded snapshot store. Zero imports (C3). |
| `server/twilio/handoff.ts` | **new** | The `handoff` `ToolDef` wrapping TAC's tool, plus the pending-reason intent store. |
| `server/twilio/voice.ts` | edit | `actionUrl` in `VOICE_TWIML_OPTIONS`; snapshot + drain after streaming; handoff beats `end_call`; clear both on disconnect. |
| `server/twilio/voice-token.ts` | **new** | AccessToken + VoiceGrant minting (C1). The only new file importing `twilio`. |
| `server/twilio/tac.ts` | edit | Register the tool in the augmented catalog; assert `actionUrl` non-empty at boot. |
| `server/http/routes-voice-action.ts` | **new** | `POST /api/voice/relay-action`. Returns TwiML on **every** path. |
| `server/http/routes-handoff.ts` | **new** | `GET /api/handoff/context`, `POST /api/voice/token`. |
| `server/http/app.ts` | edit | Register both route modules; correct the `handoff` fixture comment. |
| `server/index.ts` | edit | Inject `mintToken` once Twilio config exists. |
| `server/agent/prompt/defaults.ts` | edit | Name `handoff` in both prompts' `config.tools`; add when-to-transfer guidance. |
| `web/src/app/softphone/page.tsx` | **new** | Server component wrapping one client island. |
| `web/src/app/softphone/softphone-client.tsx` | **new** | `'use client'`. Dynamically imports `@twilio/voice-sdk`; registers, rings, screen-pops, answers. |
| `scripts/studio-handoff-flow.ts` | **new** | The committed flow definition. |
| `scripts/seed-studio-flow.ts` | **new** | Backs up the live revision to disk, then publishes. Mirrors `seed-knowledge`. |
| `tests/handoff.test.ts` | **new** | The tool, the intent store, the snapshot store. |
| `tests/helpers/fake-tac.ts` | **new** | A fake TAC handle shared by the handoff and voice suites. Not collected as a test. |
| `tests/voice-action.test.ts` | **new** | Every TwiML branch of the action route, including unparseable input. |
| `tests/handoff-http.test.ts` | **new** | The token route (grant shape, 503 paths) and the screen-pop route. |
| `tests/tools.test.ts` | edit | One over-broad preflight assertion; see Task 1 Step 5. |
| `tests/voice.test.ts` | edit | Drain ordering, handoff-beats-`end_call`, disconnect clears the snapshot. |
| `tests/builtin-tools.test.ts` | edit | Flip the `expect(names).not.toContain('handoff')` assertion (line 277). |
| `tests/config.test.ts` | edit | Assert `caps.handoff` true when the flow SID is set. Already partly covered. |
| `docs/HANDOFF.md` | edit | Fold in the spec's §2 and §3. |

---

### Task 1: Shared constants and the tool-name list

Foundation only — no behaviour changes, so it lands green on its own.

**Files:**
- Create: `shared/handoff.ts`
- Modify: `shared/tac-tool-names.ts:31`
- Test: `tests/shared-purity.test.ts` (already exists and will scan the new file automatically)

**Interfaces:**
- Consumes: nothing.
- Produces: `CLIENT_IDENTITY: 'browser_agent'`, `VOICE_ACTION_PATH`, `VOICE_TOKEN_PATH`, `HANDOFF_CONTEXT_PATH`, `HandoffContextResponse`, `HandoffTranscriptTurn`, `HandoffMatch`. `TAC_TOOL_NAMES[2] === 'handoff'`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools.test.ts`:

```ts
import { TAC_TOOL_NAMES, isTacToolName } from '../shared/tac-tool-names.ts';

test('handoff is a known TAC tool name, appended so the positional reads do not move', () => {
  // `server/twilio/builtin-tools.ts` reads TAC_TOOL_NAMES[0] and [1] by index. Appending is the
  // only safe edit; inserting would silently rename two live tools.
  expect(TAC_TOOL_NAMES[0]).toBe('retrieve_profile_memory');
  expect(TAC_TOOL_NAMES[1]).toBe('search_knowledge');
  expect(TAC_TOOL_NAMES[2]).toBe('handoff');
  expect(isTacToolName('handoff')).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- tests/tools.test.ts`
Expected: FAIL — `expect(TAC_TOOL_NAMES[2]).toBe('handoff')` receives `undefined`.

- [ ] **Step 3: Append the name**

In `shared/tac-tool-names.ts`, replace line 31:

```ts
export const TAC_TOOL_NAMES = ['retrieve_profile_memory', 'search_knowledge', 'handoff'] as const;
```

And extend that file's "What this list is NOT" comment with one sentence:

```
 * ⚠ APPEND ONLY. `server/twilio/builtin-tools.ts` reads index 0 and index 1 by position, and
 * `server/twilio/handoff.ts` reads index 2. Inserting a name renames live tools silently, which a
 * prompt naming the old string then reports only as one `unknown` warning per turn.
```

- [ ] **Step 4: Create `shared/handoff.ts`**

```ts
/**
 * The handoff contract shared by the server, the Studio flow definition and the softphone page.
 *
 * `shared/` is compiled by BOTH tsconfig projects, so nothing here may touch a Node or DOM global.
 * Everything below is pure data or a type.
 */

/**
 * The Voice SDK identity the softphone registers as, and the identity the Studio flow dials.
 *
 * NO HYPHEN, and that is the whole reason this is a constant rather than a literal in three places.
 * The Voice JS SDK documents the token identity as "may only contain alpha-numeric and underscore
 * characters". The orphan flow published on this account dials `client:browser-agent`, which is
 * outside that set — whether it works is undocumented and untested. The flow is an orphan (no phone
 * number references it), so changing it costs nothing and removes an undocumented dependency.
 */
export const CLIENT_IDENTITY = 'browser_agent';

/**
 * The `<Connect action>` URL. OURS, not TAC's `/conversation-relay-callback`.
 *
 * TAC's route answers `text/plain "OK"` and its payload schema has no `HandoffData` field, so it
 * STRIPS the handoff and then ends the call. Pinning this path in `defaultTwimlOptions` is what makes
 * the handoff reachable at all — see the design doc §2.1.
 *
 * Under `/api/` deliberately: `APP_API_PATHS` already covers that prefix, so the Traefik router rules
 * and `tests/architecture.test.ts` need no change.
 */
export const VOICE_ACTION_PATH = '/api/voice/relay-action';

/** Mints a Voice SDK AccessToken for `CLIENT_IDENTITY`. POST, because it is a credential. */
export const VOICE_TOKEN_PATH = '/api/voice/token';

/** The screen pop: what the human agent sees before they say hello. */
export const HANDOFF_CONTEXT_PATH = '/api/handoff/context';

/**
 * How confidently the screen pop was matched to the ringing call.
 *
 * Reported to the UI rather than hidden, because the two weak cases are real: Studio's
 * `connect-call-to` widget cannot pass parameters to a client, and dialling a client mints a NEW call
 * leg with a NEW CallSid, so `call.parameters.CallSid` in the browser can never match the inbound
 * call. See the design doc §3.2.
 *
 *  - `exact`  — matched on `conversationId`, carried as a `<Parameter>` on the direct-Dial path.
 *  - `caller` — matched on the caller's number, which Studio preserves via `caller_id`.
 *  - `recent` — fell back to the most recent snapshot. Correct in a demo, wrong under load.
 *  - `none`   — no snapshot at all; the pop shows the number and nothing else.
 */
export type HandoffMatch = 'exact' | 'caller' | 'recent' | 'none';

export interface HandoffTranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface HandoffContextResponse {
  readonly found: boolean;
  readonly match: HandoffMatch;
  /** The model's own words for why it transferred. `null` when `found` is false. */
  readonly reason: string | null;
  readonly conversationId: string | null;
  /** MASKED for display. The verbatim number is never sent to the browser. */
  readonly maskedFrom: string | null;
  /** ISO 8601, so the UI can say how stale the snapshot is. */
  readonly at: string | null;
  /**
   * Verbatim, and deliberately NOT scrubbed. `server/obs/pii.ts` scrubs log lines and obs payloads;
   * the human agent needs the real words the caller said. This is a new PII surface and the design
   * doc §10 states it rather than hiding it.
   */
  readonly transcript: readonly HandoffTranscriptTurn[];
}
```

- [ ] **Step 5: Fix the one existing test that appending to the list breaks**

Appending `handoff` to `TAC_TOOL_NAMES` breaks `tests/tools.test.ts` at what is currently line 305:

```ts
  for (const name of TAC_TOOL_NAMES) expect(logger.lines[0]?.msg).toContain(name);
```

The preflight's debug line lists only the TAC-provided names that a **compiled default prompt actually
names**. `handoff` is in the list from this task but is not named by a prompt until Task 8, so the
assertion fails in between. Do not work around it by reordering the tasks — the assertion is simply
over-broad. Replace it with one derived from the defaults, which is what it was really trying to say:

```ts
  // Derived from the DEFAULTS, not from TAC_TOOL_NAMES: the preflight reports the TAC-provided names a
  // compiled prompt names, which is a subset. Asserting the whole list would fail the moment a tool is
  // added to the list before a prompt names it — which is exactly what T14b.1 does.
  const namedByDefaults = new Set(
    PROMPT_NAMES.flatMap((p) => DEFAULT_PROMPTS[p].config.tools).filter((n) =>
      (TAC_TOOL_NAMES as readonly string[]).includes(n),
    ),
  );
  expect(namedByDefaults.size).toBeGreaterThan(0);
  for (const name of namedByDefaults) expect(logger.lines[0]?.msg).toContain(name);
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, 292 tests. `tests/shared-purity.test.ts` picks the new file up with no edit — it asserts `shared/` imports nothing outside itself, and `shared/handoff.ts` imports nothing at all.

⚠ Two other assertions in `tests/tools.test.ts` pass unchanged and are worth understanding rather than
re-running blind. Line ~276 builds `buildable = toolCatalog.names ∪ TAC_TOOL_NAMES` and checks every
default prompt's tools are in it — appending only widens that set. Line ~288 asserts `TAC_TOOL_NAMES` is
disjoint from the shipped catalog, and `handoff` is not a shipped tool, so it stays disjoint.

- [ ] **Step 7: Commit**

```bash
git add shared/handoff.ts shared/tac-tool-names.ts tests/tools.test.ts
git commit -m "T14b.1: the shared handoff contract, and 'handoff' appended where index order is load-bearing"
```

---

### Task 2: The snapshot store and the `handoff` tool

The tool records an INTENT and delegates the payload construction to TAC. It does not send anything.

**Files:**
- Create: `server/handoff/snapshots.ts`
- Create: `server/twilio/handoff.ts`
- Modify: `server/twilio/tac.ts:201-225` (register the tool), `server/twilio/builtin-tools.ts:50-51` (the `handoff` deferral comment is now stale)
- Test: `tests/handoff.test.ts` (new), `tests/helpers/fake-tac.ts` (new, shared with Task 3), `tests/builtin-tools.test.ts:270-278` (flip the assertion)

**Interfaces:**
- Consumes: `TAC_TOOL_NAMES[2]`, `HandoffTranscriptTurn` (Task 1); `ToolDef`, `ToolLogger`, `ToolCtx` from `server/agent/tools/registry.ts`.
- Produces:
  - `server/handoff/snapshots.ts`: `interface HandoffSnapshot { conversationId: string; reason: string; from: string | null; at: string; transcript: readonly HandoffTranscriptTurn[] }`, `recordHandoffSnapshot(s: HandoffSnapshot): void`, `findHandoffSnapshot(q: { conversationId?: string | null; from?: string | null }): { snapshot: HandoffSnapshot | null; match: HandoffMatch }`, `forgetHandoffSnapshot(conversationId: string): void`, `handoffSnapshotCount(): number`.
  - `server/twilio/handoff.ts`: `handoffTool(deps: { tac: TAC; sessions: HandoffSessionSource }): ToolDef`, `interface HandoffSessionSource { getConversationSession(conversationId: string): ConversationSession | undefined }`, `consumeHandoffRequest(conversationId: string): string | null`, `forgetHandoffRequest(conversationId: string): void`.

- [ ] **Step 1: Write the failing test for the snapshot store**

Create `tests/handoff.test.ts`:

```ts
import { test, expect } from 'vitest';
import {
  recordHandoffSnapshot,
  findHandoffSnapshot,
  forgetHandoffSnapshot,
  handoffSnapshotCount,
  HANDOFF_MAX_SNAPSHOTS,
} from '../server/handoff/snapshots.ts';

const snap = (conversationId: string, from: string | null, at: string) => ({
  conversationId,
  reason: `reason for ${conversationId}`,
  from,
  at,
  transcript: [{ role: 'user' as const, text: 'I want a human' }],
});

test('an exact conversationId match beats a caller match', () => {
  recordHandoffSnapshot(snap('conv_a', '+15551110000', '2026-09-14T10:00:00.000Z'));
  recordHandoffSnapshot(snap('conv_b', '+15551110000', '2026-09-14T10:01:00.000Z'));

  const exact = findHandoffSnapshot({ conversationId: 'conv_a', from: '+15551110000' });
  expect(exact.match).toBe('exact');
  expect(exact.snapshot?.conversationId).toBe('conv_a');

  forgetHandoffSnapshot('conv_a');
  forgetHandoffSnapshot('conv_b');
});

test('a caller match picks the MOST RECENT snapshot for that number', () => {
  // Two calls from one number is the realistic redial, and the newer one is the live call.
  recordHandoffSnapshot(snap('conv_old', '+15552220000', '2026-09-14T10:00:00.000Z'));
  recordHandoffSnapshot(snap('conv_new', '+15552220000', '2026-09-14T10:05:00.000Z'));

  const found = findHandoffSnapshot({ from: '+15552220000' });
  expect(found.match).toBe('caller');
  expect(found.snapshot?.conversationId).toBe('conv_new');

  forgetHandoffSnapshot('conv_old');
  forgetHandoffSnapshot('conv_new');
});

test('an unknown number falls back to the most recent snapshot and SAYS it did', () => {
  // Studio's connect-call-to widget cannot pass parameters to a client, and dialling a client mints a
  // new CallSid — so `recent` is the honest disposition, not a bug. The UI renders the distinction.
  recordHandoffSnapshot(snap('conv_only', '+15553330000', '2026-09-14T10:00:00.000Z'));

  const found = findHandoffSnapshot({ from: '+19998887777' });
  expect(found.match).toBe('recent');
  expect(found.snapshot?.conversationId).toBe('conv_only');

  forgetHandoffSnapshot('conv_only');
});

test('an empty store reports none, not a throw', () => {
  expect(handoffSnapshotCount()).toBe(0);
  expect(findHandoffSnapshot({ from: '+15550000000' })).toEqual({ snapshot: null, match: 'none' });
});

test('the store is bounded, oldest-first', () => {
  for (let i = 0; i <= HANDOFF_MAX_SNAPSHOTS; i += 1) {
    recordHandoffSnapshot(snap(`conv_${i}`, `+1555000${String(i).padStart(4, '0')}`, '2026-09-14T10:00:00.000Z'));
  }
  expect(handoffSnapshotCount()).toBe(HANDOFF_MAX_SNAPSHOTS);
  // The first one in is the first one out.
  expect(findHandoffSnapshot({ conversationId: 'conv_0' }).match).not.toBe('exact');
  for (let i = 0; i <= HANDOFF_MAX_SNAPSHOTS; i += 1) forgetHandoffSnapshot(`conv_${i}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- tests/handoff.test.ts`
Expected: FAIL — `Cannot find module '../server/handoff/snapshots.ts'`.

- [ ] **Step 3: Write the snapshot store**

Create `server/handoff/snapshots.ts`:

```ts
/**
 * What the human agent sees before they say hello.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE IMPORTS NOTHING BUT `shared/`, AND THAT IS DELIBERATE.
 *
 * `server/twilio/voice.ts` writes these and `server/http/routes-handoff.ts` reads them. If the store
 * lived beside the tool in `server/twilio/handoff.ts`, the HTTP layer would import a module that
 * imports `twilio-agent-connect`, and a process with no Twilio credentials would load the vendor at
 * module load — destroying the property that `server/index.ts`'s dynamic `bootTac` import exists to
 * buy. Keeping the store vendor-free is what lets both sides reach it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A STORE AT ALL, rather than putting the transcript in the handoff payload: TAC's
 * `HandoffPayloadSchema` has exactly four keys — `conversationId`, `storeId`, `profileId`,
 * `attributes` — and `attributes` is the only extension point. A whole transcript would ride through
 * ConversationRelay, Twilio's action POST and a Studio flow variable as one JSON string. The
 * conversation id is enough of a key; the words stay in the process that heard them.
 */
import type { HandoffMatch, HandoffTranscriptTurn } from '../../shared/handoff.ts';

/**
 * Small on purpose. A snapshot is only useful for the seconds between the frame going out and a human
 * pressing answer, and every entry holds a full transcript. Eviction is a backstop, not a mechanism.
 */
export const HANDOFF_MAX_SNAPSHOTS = 20;

export interface HandoffSnapshot {
  readonly conversationId: string;
  /** The model's own words. Written for a human to read in a toast, not for a log. */
  readonly reason: string;
  /** The caller's number, VERBATIM. Masked only at the HTTP boundary. `null` if TAC had none. */
  readonly from: string | null;
  /** ISO 8601. The UI shows how stale the snapshot is, because `recent` matches can be stale. */
  readonly at: string;
  readonly transcript: readonly HandoffTranscriptTurn[];
}

/** Insertion-ordered, so the last entry is the newest — that is the whole eviction mechanism. */
const snapshots = new Map<string, HandoffSnapshot>();

export function recordHandoffSnapshot(snapshot: HandoffSnapshot): void {
  // Delete-then-set, so a re-recorded conversation moves to the end rather than keeping its old slot.
  snapshots.delete(snapshot.conversationId);
  snapshots.set(snapshot.conversationId, snapshot);
  while (snapshots.size > HANDOFF_MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next();
    if (oldest.done === true) break;
    snapshots.delete(oldest.value);
  }
}

/**
 * Best available match, and it reports WHICH match it made.
 *
 * The three-rung ladder is forced by what the browser can know. On the direct-`<Dial>` path we emit
 * `<Parameter name="conversationId">`, which the Voice SDK surfaces as `call.customParameters`, so
 * that path gets an exact match. On the Studio path the widget cannot pass parameters to a client at
 * all, and dialling the client mints a new call leg with a new CallSid, so the caller's number — which
 * Studio preserves via `caller_id` — is the only correlator left. `recent` covers a flow that dropped
 * even that. See the design doc §3.2.
 */
export function findHandoffSnapshot(query: {
  readonly conversationId?: string | null;
  readonly from?: string | null;
}): { readonly snapshot: HandoffSnapshot | null; readonly match: HandoffMatch } {
  if (query.conversationId != null) {
    const exact = snapshots.get(query.conversationId);
    if (exact !== undefined) return { snapshot: exact, match: 'exact' };
  }

  const all = [...snapshots.values()];
  if (all.length === 0) return { snapshot: null, match: 'none' };

  if (query.from != null) {
    // Last wins: insertion order makes the final match the most recently recorded, which on a redial
    // is the live call rather than the one that hung up.
    const byCaller = all.filter((s) => s.from === query.from).at(-1);
    if (byCaller !== undefined) return { snapshot: byCaller, match: 'caller' };
  }

  const newest = all.at(-1);
  return newest === undefined ? { snapshot: null, match: 'none' } : { snapshot: newest, match: 'recent' };
}

/**
 * Drop one snapshot.
 *
 * ⚠ NOT CALLED FROM `handleVoiceDisconnect`, and that is the opposite of what the design doc §6 says.
 * The socket closes BECAUSE we sent the handoff frame, so disconnect fires seconds before the human
 * presses answer — clearing here would make the screen pop reliably empty on the one path it exists
 * for. The snapshot's lifetime is bounded by `HANDOFF_MAX_SNAPSHOTS` eviction instead. The `end_call`
 * intent and the handoff INTENT are still cleared on disconnect; only the snapshot outlives the call.
 */
export function forgetHandoffSnapshot(conversationId: string): void {
  snapshots.delete(conversationId);
}

/** For the operator console and for asserting eviction actually removed an entry. */
export function handoffSnapshotCount(): number {
  return snapshots.size;
}
```

- [ ] **Step 4: Run the store tests**

Run: `pnpm test -- tests/handoff.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Create the shared TAC fake**

⚠ **`fakeTac` goes in `tests/helpers/fake-tac.ts`, not inline.** `tests/voice.test.ts` needs the same
fake in Task 3, and `vitest.config.ts` includes only `tests/**/*.test.ts`, so a helper file there is not
collected as a suite. Create it with exactly this content and import it from both test files:

```ts
/**
 * A fake TAC handle, used to exercise TAC's REAL `createStudioHandoffTool`.
 *
 * That is the point of it: the voice branch touches exactly four things on the handle, so a fake is
 * honest here in a way that mocking our own tool would not be — it proves TAC's three construction
 * guards and the parked frame's exact shape against the installed vendor bundle.
 *
 * Shared by `tests/handoff.test.ts` and `tests/voice.test.ts` rather than copied into each. `calls`
 * records the Conversation Orchestrator side effects in order, which is what proves INACTIVE and
 * clearStatusCallbacks happen BEFORE the frame is parked.
 */
import type { TAC } from 'twilio-agent-connect';

export const fakeTac = (over: { flowSid?: string | null; storeId?: string | null } = {}): TAC => {
  const calls: string[] = [];
  const tac = {
    getConfig: () => ({
      studioHandoffFlowSid: over.flowSid === undefined ? 'FW' + 'a'.repeat(32) : over.flowSid,
      phoneNumber: '+15550001111',
      apiKey: 'SK' + 'b'.repeat(32),
      apiSecret: 'secret',
    }),
    getConversationClient: () => ({
      updateConversation: async (id: string, status: string) => {
        calls.push(`update:${id}:${status}`);
      },
      clearStatusCallbacks: async (id: string) => {
        calls.push(`clear:${id}`);
      },
    }),
    getMemoryStoreId: () => (over.storeId === undefined ? 'store_test' : over.storeId),
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    calls,
  };
  return tac as unknown as TAC;
};
```

- [ ] **Step 6: Write the failing test for the tool**

Append to `tests/handoff.test.ts`:

```ts
import type { ConversationSession } from 'twilio-agent-connect';
import { handoffTool, consumeHandoffRequest, forgetHandoffRequest } from '../server/twilio/handoff.ts';
import type { ToolCtx, ToolLogger } from '../server/agent/tools/registry.ts';
import { fakeTac } from './helpers/fake-tac.ts';

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };
const ctx = (conversationId: string): ToolCtx => ({
  conversationId,
  logger: silentLogger,
  profileId: 'profile_test',
});

const voiceSession = (conversationId: string): ConversationSession =>
  ({
    conversationId,
    channel: 'voice',
    profileId: 'profile_test',
    startedAt: new Date('2026-09-14T10:00:00.000Z'),
    authorInfo: { address: '+15554443333' },
    metadata: {},
  }) as unknown as ConversationSession;

test('the tool parks a complete end frame on the session and records the reason', async () => {
  const session = voiceSession('conv_tool_1');
  const tac = fakeTac();
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });

  expect(tool.name).toBe('handoff');
  expect(tool.requires).toBe('handoff');

  const result = await tool.execute({ reason: 'caller asked for a person' }, ctx('conv_tool_1'));

  // The frame is READY TO SEND, not raw data — `{type:'end', handoffData:"<json>"}`. The double
  // encoding is required: Twilio documents handoffData as a JSON-encoded STRING.
  const parked = (session as unknown as { pendingHandoffData?: { type: string; handoffData: string } })
    .pendingHandoffData;
  expect(parked?.type).toBe('end');
  const payload = JSON.parse(parked?.handoffData ?? '{}');
  expect(payload).toMatchObject({ conversationId: 'conv_tool_1', storeId: 'store_test', profileId: 'profile_test' });
  // `attributes` is the ONLY extension point — the payload's other three keys are fixed — so
  // reasonCode rides inside it, and the model's reason always overwrites a static one.
  // `live-agent-handoff` is TWILIO'S OWN documented reasonCode for this, and its action-handler
  // example branches on exactly that string. Do not invent a house value.
  expect(payload.attributes).toEqual({ reasonCode: 'live-agent-handoff', reason: 'caller asked for a person' });

  // Addressed to the model, mirroring end_call: it must say one line and stop.
  expect(result).toMatchObject({ transferring: true });

  // The intent is what `voice.ts` consumes AFTER the farewell has streamed.
  expect(consumeHandoffRequest('conv_tool_1')).toBe('caller asked for a person');
  expect(consumeHandoffRequest('conv_tool_1')).toBeNull();
});

test('TAC sets the conversation INACTIVE and clears status callbacks BEFORE parking the frame', async () => {
  const session = voiceSession('conv_tool_2');
  const tac = fakeTac();
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });

  await tool.execute({ reason: 'escalation' }, ctx('conv_tool_2'));

  // Both are warn-only inside TAC and neither has an inverse. On the SUCCESS path Studio flips the
  // status back to ACTIVE on pickup; the unreverted-INACTIVE landmine is the FAILURE path, which is
  // exactly what sending the frame eliminates. Design doc §2.5.
  expect((tac as unknown as { calls: string[] }).calls).toEqual([
    'update:conv_tool_2:INACTIVE',
    'clear:conv_tool_2',
  ]);
  forgetHandoffRequest('conv_tool_2');
});

test('a missing session is a structured miss, never a throw', async () => {
  const tool = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } });
  const result = await tool.execute({ reason: 'x' }, ctx('conv_tool_3'));
  expect(result).toMatchObject({ found: false });
  expect(consumeHandoffRequest('conv_tool_3')).toBeNull();
});

test("an unset flow SID is a miss, not a boot crash — construction is lazy", async () => {
  // TAC's first guard throws at CONSTRUCTION. Constructing inside `execute` is what turns that into
  // something the model can speak about instead of dead air.
  const tool = handoffTool({
    tac: fakeTac({ flowSid: null }),
    sessions: { getConversationSession: () => voiceSession('conv_tool_4') },
  });
  const result = await tool.execute({ reason: 'x' }, ctx('conv_tool_4'));
  expect(result).toMatchObject({ found: false });
  expect(consumeHandoffRequest('conv_tool_4')).toBeNull();
});

test('the mirror matches what TAC declares, so a schema drift is caught here', () => {
  const tool = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } });
  expect(tool.input.safeParse({}).success).toBe(false);
  expect(tool.input.safeParse({ reason: 'caller asked for a human' }).success).toBe(true);
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm test -- tests/handoff.test.ts`
Expected: FAIL — `Cannot find module '../server/twilio/handoff.ts'`.

- [ ] **Step 8: Write the tool**

Create `server/twilio/handoff.ts`:

```ts
/**
 * `handoff` — the tool that transfers a caller to a human, and the third TAC built-in we adapt.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS TOOL DOES NOT TRANSFER THE CALL. IT RECORDS AN INTENT AND PARKS A FRAME.
 *
 * The same argument as `../agent/tools/end-call.ts`, and the same shape: a tool runs INSIDE the model
 * loop, before the turn's text exists, so transferring here cuts the caller off mid-sentence — before
 * the model has even written the line that says what is about to happen. `execute` therefore does two
 * things and neither of them touches the WebSocket: it delegates to TAC, which parks a ready-made
 * `{type:'end', handoffData}` frame on the session, and it records the reason. `./voice.ts` sends the
 * frame after the farewell has streamed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY TAC'S TOOL RATHER THAN OUR OWN FRAME. `session.pendingHandoffData` is a COMPLETE frame, not raw
 * data (`dist/index.js:6487-6490`), and TAC's tool also does the two Conversation Orchestrator
 * side-effects a hand-built frame would silently skip: `updateConversation(..., 'INACTIVE')` and
 * `clearStatusCallbacks(...)`. What TAC omits is the DRAIN on a streaming channel — its own five-line
 * drain lives inside `sendResponse` (`dist/index.js:5245-5254`) and `sendStreamingResponse` has zero
 * references to the field. So the split is: TAC builds, we send. Design doc §2.4.
 *
 * WHY CONSTRUCTION IS LAZY, inside `execute`, exactly like `./builtin-tools.ts`: TAC's factory has
 * three guards that THROW at construction (flow SID, Conversation Orchestrator, memory store id). At
 * boot that is a crash; inside `execute` it is a structured miss the model can speak about.
 *
 * VOICE-ONLY BY PROMPT, and deliberately — see `../agent/prompt/defaults.ts`. TAC's tool branches
 * internally on `session.channel === 'voice'` and the digital branch works, but it POSTs to the Studio
 * Executions endpoint and only THEN can fail, having already set the conversation INACTIVE and cleared
 * its status callbacks with no inverse anywhere in TAC. On SMS that leaves a customer whose next text
 * reaches nothing. The frame-sending work in this task mitigates that failure path on voice; nothing
 * mitigates it on SMS, so the text prompt does not name this tool.
 */
import { createStudioHandoffTool, type ConversationSession, type TAC } from 'twilio-agent-connect';
import { z } from 'zod';
import { TAC_TOOL_NAMES } from '../../shared/tac-tool-names.ts';
import type { ToolDef, ToolLogger } from '../agent/tools/registry.ts';

/**
 * Index 2, and `shared/tac-tool-names.ts` says why the list is append-only: `./builtin-tools.ts`
 * reads 0 and 1 positionally. Same string as `BuiltInTools.HANDOFF`, which `tests/handoff.test.ts`
 * pins so the coincidence stays deliberate rather than becoming a stale copy.
 */
const HANDOFF_NAME = TAC_TOOL_NAMES[2];

/**
 * OURS, and it is load-bearing for the same reason `search_knowledge`'s is.
 *
 * TAC's default — "Use this when the customer requests a human, or when you cannot adequately handle
 * the request" — invites a transfer whenever the model feels stuck. On a demo that means transferring
 * instead of searching the policy library, which is the one behaviour that makes the whole knowledge
 * feature look broken. So this description names the alternative explicitly.
 *
 * The WHEN also lives in the Langfuse-versioned prompt, which is what makes it tunable in front of a
 * customer without a redeploy. This string is the floor, not the whole policy.
 */
const HANDOFF_DESCRIPTION =
  'Transfer this phone call to a human colleague, ending your own part of the conversation. Use it ' +
  'when the caller asks to speak to a person, or when they are upset enough that a person should ' +
  'take over. Do NOT use it because a question is hard: look the answer up first — policy questions ' +
  'are answered by searching the written policies, and order questions by looking the order up. Do ' +
  'not use it to end a call that is simply finished; that is what ending the call is for. Once you ' +
  'call this, say one short line telling the caller you are putting them through, and nothing else.';

/**
 * The mirror of TAC's own parameter schema (`dist/index.js:6455-6466`), including the object-level
 * description, so `tests/handoff.test.ts` can deep-equal against it.
 *
 * Unlike `search_knowledge`'s mirror, the top-level `.describe()` is kept: TAC hard-codes this
 * schema and never echoes `options.description` into it, so there is no circularity and no duplicated
 * prose — the string is 39 characters rather than 900.
 */
const HandoffInput = z
  .object({
    reason: z.string().min(1).describe('The reason for handing off to a human agent'),
  })
  .describe('Hand off the conversation to a human agent');

/**
 * `attributes` is the ONLY extension point on the payload — its other three keys (`conversationId`,
 * `storeId`, `profileId`) are built by TAC from the session. `reasonCode` is Twilio's convention for
 * naming a handoff cause, so it rides in here, and `live-agent-handoff` is the value Twilio's own
 * documentation uses — its action-handler example branches on that exact string, so our route can too. Note TAC merges as
 * `{...staticAttributes, reason: params.reason}`, so the model's reason always wins over a static one
 * of the same name — do not put a `reason` key here expecting it to survive.
 */
const HANDOFF_ATTRIBUTES = { reasonCode: 'live-agent-handoff' } as const;

/**
 * Bounded, for the same reason `end-call.ts`'s store is: `consume` is only ever called by the voice
 * handler, so a prompt naming this tool on a channel that ignores it would add entries nothing
 * removes.
 */
const MAX_PENDING = 100;

/** conversationId → the reason the model gave. */
const pending = new Map<string, string>();

/**
 * The two members of `VoiceChannel` this file needs, narrowed the way `./voice.ts` narrows its sender.
 *
 * METHOD SYNTAX IS LOAD-BEARING. TAC declares `getConversationSession(id: ConversationId)` with a
 * BRANDED string, and TypeScript checks method parameters bivariantly — so a `VoiceChannel` stays
 * assignable to this interface without a cast anywhere. Declared as a property (`getConversationSession:
 * (id: string) => ...`) it would be checked contravariantly and rejected.
 *
 * `getConversationSession` is public on `BaseChannel`, so it comes off the CHANNEL and not off `TAC` —
 * the design doc records the opposite claim in `docs/HANDOFF.md` as one of its corrections.
 */
export interface HandoffSessionSource {
  getConversationSession(conversationId: string): ConversationSession | undefined;
}

export interface HandoffToolDeps {
  /**
   * The real handle, not a narrowed interface. `createStudioHandoffTool` takes a `TAC` and reads four
   * things off it (`getConfig`, `getConversationClient`, `getMemoryStoreId`, `logger`), so narrowing
   * would force a cast around the one contract this file exists to honour — the same reasoning
   * `./builtin-tools.ts` gives for typing its clients with TAC's own classes.
   */
  readonly tac: TAC;
  readonly sessions: HandoffSessionSource;
}

/** The structured-miss shape, one convention across the whole catalog. See `./builtin-tools.ts`. */
const miss = (message: string): { readonly found: false; readonly message: string } => ({
  found: false,
  message,
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function handoffTool(deps: HandoffToolDeps): ToolDef<typeof HandoffInput> {
  return {
    name: HANDOFF_NAME,
    description: HANDOFF_DESCRIPTION,
    input: HandoffInput,
    /**
     * `handoff` is `orchestrated && studioHandoffFlowSid !== null` — the capability already existed in
     * `server/config.ts` and this is the first tool to claim it. A process without it offers nothing:
     * `resolve()` reports `unavailable` with one debug line and the turn proceeds.
     */
    requires: 'handoff',
    async execute({ reason }, ctx) {
      const log = (level: keyof ToolLogger, fields: Record<string, unknown>, msg: string): void =>
        ctx.logger[level]({ tool: HANDOFF_NAME, conversationId: ctx.conversationId, ...fields }, msg);

      const session = deps.sessions.getConversationSession(ctx.conversationId);
      if (session === undefined) {
        // The session is created before TAC dispatches a prompt, so this means the socket closed
        // between the model deciding to transfer and the tool running — the caller hung up.
        log('warn', {}, 'handoff: no TAC session for this conversation, so there is nothing to transfer');
        return miss(
          'The call could not be transferred just now. Tell the caller you cannot put them through ' +
            'and offer to have a colleague call them back.',
        );
      }

      try {
        const tool = createStudioHandoffTool(deps.tac, session, {
          name: HANDOFF_NAME,
          description: HANDOFF_DESCRIPTION,
          attributes: HANDOFF_ATTRIBUTES,
        });
        const result = await tool.implementation({ reason });

        if (result.status === 'handoff_failed') {
          // Only reachable on a digital channel — the voice branch cannot fail, it just assigns the
          // frame. Kept because the tool is channel-agnostic and a silent `handoff_failed` would leave
          // the conversation INACTIVE with nobody coming.
          log('warn', { error: result.error, channel: result.channel }, 'handoff: TAC could not deliver the handoff');
          return miss(
            'The transfer did not go through. Tell the caller you cannot put them through and offer ' +
              'to have a colleague call them back.',
          );
        }

        if (pending.size >= MAX_PENDING) {
          const oldest = pending.keys().next();
          if (oldest.done !== true) pending.delete(oldest.value);
        }
        pending.set(ctx.conversationId, reason);
        log(
          'debug',
          { reason, channel: result.channel },
          'handoff: frame parked on the session; the channel will send it after this turn is spoken',
        );

        // Addressed to the model. Saying the transfer is already happening is what stops it asking a
        // question it will never hear the answer to.
        return {
          transferring: true,
          instruction:
            'You are being connected to a colleague now. Say one short line telling the caller you ' +
            'are putting them through — no questions, no offers of further help.',
        };
      } catch (err) {
        // TAC's three construction guards and the Orchestrator round-trips share one catch: all fail
        // for reasons outside the process and the model's next move is identical either way.
        log('warn', { error: errorMessage(err) }, 'handoff: could not start the transfer');
        return miss(
          'The call could not be transferred just now. Tell the caller you cannot put them through ' +
            'and offer to have a colleague call them back.',
        );
      }
    },
  };
}

/**
 * Read and clear the intent for one conversation. Returns the reason, or `null` if none was set.
 *
 * Clearing on read makes the transfer fire exactly once, and means the store self-empties on the happy
 * path — the same contract as `consumeEndCallRequest`.
 */
export function consumeHandoffRequest(conversationId: string): string | null {
  const reason = pending.get(conversationId);
  if (reason === undefined) return null;
  pending.delete(conversationId);
  return reason;
}

/** Drop any intent for a conversation that ended some other way — a hangup, a sweep, a shutdown. */
export function forgetHandoffRequest(conversationId: string): void {
  pending.delete(conversationId);
}
```

- [ ] **Step 9: Run the tool tests**

Run: `pnpm test -- tests/handoff.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 10: Register the tool in the augmented catalog**

In `server/twilio/tac.ts`, add the import beside `adaptBuiltInTools`:

```ts
import { handoffTool } from './handoff.ts';
```

Replace lines 201-202 (`const builtInTools = ...` and `const catalog = ...`) with:

```ts
  const builtInTools = adaptBuiltInTools({ tac, knowledgeBaseId: config.knowledgeBaseId });
  /**
   * `handoff` is built here rather than inside `adaptBuiltInTools` because it needs the CHANNEL, not
   * just `tac`: `getConversationSession` is public on `BaseChannel` and absent from `TAC`. The voice
   * channel is constructed below, so the tool closes over a getter rather than the object — a plain
   * reference would capture `null`.
   *
   * Included even when `caps.voice` is false: `requires: 'handoff'` is the gate, and building the
   * catalog identically on every process keeps `catalog.names` honest in the boot log and in
   * `/health`. With no voice channel the getter returns undefined and the tool reports a miss.
   */
  const handoff = handoffTool({
    tac,
    sessions: {
      getConversationSession: (conversationId) => voiceChannel?.getConversationSession(conversationId as never),
    },
  });
  const catalog = createToolCatalog([...SHIPPED_TOOLS, ...builtInTools, handoff]);
```

⚠ `voiceChannel` is declared with `let` at line 247, BELOW this point. Move the two declarations
(`const registries: ConversationRegistry[] = []` and `let voiceChannel: VoiceChannel | null = null`)
to just above `const builtInTools = ...` so the closure references an initialised binding. The
`as never` on the argument is TAC's branded `ConversationId`; the cast is at the vendor boundary and
is the only one in this file's tool wiring.

Then extend the `log.info` call at line 218 to include the new tool — it already logs
`builtInTools: builtInTools.map((t) => t.name)`, so add:

```ts
      handoffTool: handoff.name,
```

- [ ] **Step 11: Flip the stale assertions and comments**

In `tests/builtin-tools.test.ts`, replace the `handoff` half of the "two deliberate omissions" test
(lines 271-278) with:

```ts
test('send_message stays omitted, and handoff is no longer one of the omissions', () => {
  // `send_message` is redundant with streaming, throws SYNCHRONOUSLY on a closed socket, and is the
  // UNKNOWN-TOOL FIXTURE in tests/tools.test.ts — adding it for real turns two passing tests red for
  // a reason unrelated to what they assert.
  const names = adapt().map((t) => t.name);
  expect(names).not.toContain('send_message');
  // `handoff` landed at T14b, and it is NOT built by `adaptBuiltInTools`: it needs the voice channel
  // rather than just `tac`, so `server/twilio/tac.ts` builds it and `tests/handoff.test.ts` owns it.
  expect(names).not.toContain('handoff');
});
```

In `server/twilio/builtin-tools.ts`, replace lines 50-51:

```
 * `handoff` — NOT here, and no longer deferred. It landed at T14b in `./handoff.ts`, built by
 * `./tac.ts` rather than by this factory, because it needs `getConversationSession` off the CHANNEL
 * (public on `BaseChannel`, absent from `TAC`) and this factory only receives `tac`.
```

- [ ] **Step 12: Verify the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Test count rises from 291 to ~302.

- [ ] **Step 13: Commit**

```bash
git add server/handoff/snapshots.ts server/twilio/handoff.ts server/twilio/tac.ts \
        server/twilio/builtin-tools.ts tests/handoff.test.ts tests/helpers/fake-tac.ts \
        tests/builtin-tools.test.ts
git commit -m "T14b.2: the handoff tool — TAC builds the frame, we record the intent"
```

---

### Task 3: Send the frame — the five lines TAC omits on a streaming channel

The behavioural heart of the task. Everything before this parked a frame nothing sent.

**Files:**
- Modify: `server/twilio/voice.ts` (`VOICE_TWIML_OPTIONS` → `buildVoiceTwimlOptions`, `VoicePrompt.session`, `endSession` → `sendFrame`, the hangup block at 317-334, `handleVoiceDisconnect` at 426-443)
- Modify: `server/twilio/tac.ts:346` (call the builder), `tests/voice.test.ts:19,424`
- Test: `tests/voice.test.ts`

**Interfaces:**
- Consumes: `consumeHandoffRequest`, `forgetHandoffRequest` (Task 2); `recordHandoffSnapshot`, `HandoffSnapshot` (Task 2); `VOICE_ACTION_PATH` (Task 1).
- Produces: `buildVoiceTwimlOptions(publicDomain: string): { reportInputDuringAgentSpeech: 'any'; actionUrl: string }`. `VoicePrompt.session` widened to `{ profileId?: string | null; authorInfo?: { address?: string }; pendingHandoffData?: { type: string; handoffData: string } }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/voice.test.ts`. The first is the ordering assertion — the one that catches a truncated
goodbye, which no typecheck and no review can see:

```ts
import { buildVoiceTwimlOptions } from '../server/twilio/voice.ts';
import { handoffTool } from '../server/twilio/handoff.ts';
import { findHandoffSnapshot, forgetHandoffSnapshot } from '../server/handoff/snapshots.ts';
import { VOICE_ACTION_PATH } from '../shared/handoff.ts';

/**
 * A session object the drain can read and the tool can write, mirroring TAC's live-by-reference
 * session. TAC hands the SAME object to our prompt handler that its tool mutates, which is why the
 * drain needs no second lookup.
 */
const liveSession = (conversationId: string) => ({
  conversationId,
  channel: 'voice' as const,
  profileId: 'profile_voice',
  startedAt: new Date('2026-09-14T10:00:00.000Z'),
  authorInfo: { address: '+15557778888' },
  metadata: {},
  pendingHandoffData: undefined as { type: string; handoffData: string } | undefined,
});

test('the handoff frame goes out AFTER the farewell, and carries handoffData', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(
    ['Of course — ', 'putting you through now.'],
    'Of course — putting you through now.',
    events,
  );
  const rec = recordingSender();
  const session = liveSession('conv_handoff_1');

  // The tool runs inside the model loop on a real turn; here we run it directly, which is the same
  // sequence: it parks the frame and records the intent before the handler reaches the drain.
  await handoffTool({
    tac: fakeTac(),
    sessions: { getConversationSession: () => session as never },
  }).execute({ reason: 'caller asked for a person' }, {
    conversationId: 'conv_handoff_1',
    logger: silentLogger,
    profileId: 'profile_voice',
  });

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_1',
      transcript: 'can I talk to a human please',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
  );

  // THE ORDER IS THE ASSERTION, same as the end_call test above it. Every token, then the frame.
  expect(rec.order.slice(0, 2)).toEqual([
    'token:Of course — ',
    'token:putting you through now.',
  ]);
  const frame = rec.order[2] ?? '';
  expect(frame.startsWith('frame:')).toBe(true);
  const parsed = JSON.parse(frame.slice('frame:'.length));
  expect(parsed.type).toBe('end');
  // The double encoding is REQUIRED — Twilio documents handoffData as a JSON-encoded string.
  expect(typeof parsed.handoffData).toBe('string');
  expect(JSON.parse(parsed.handoffData)).toMatchObject({ conversationId: 'conv_handoff_1' });

  // And the frame is drained from the session, so a later turn cannot send it twice.
  expect(session.pendingHandoffData).toBeUndefined();

  const published = events.find((e) => e.kind === 'handoff');
  expect(published?.payload).toMatchObject({ reason: 'caller asked for a person', frameSent: true });

  forgetHandoffSnapshot('conv_handoff_1');
});

test('the snapshot holds the CURRENT turn — the request and the farewell', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Putting you through.'], 'Putting you through.', events);
  const rec = recordingSender();
  const session = liveSession('conv_handoff_2');

  await handoffTool({
    tac: fakeTac(),
    sessions: { getConversationSession: () => session as never },
  }).execute({ reason: 'upset caller' }, {
    conversationId: 'conv_handoff_2',
    logger: silentLogger,
    profileId: 'profile_voice',
  });

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_2',
      transcript: 'I need a person, now',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
  );

  // `run-turn.ts` appends the user+assistant pair BEFORE `done` resolves, so snapshotting at the
  // drain — not inside the tool — is what captures the line that caused the transfer.
  const { snapshot, match } = findHandoffSnapshot({ conversationId: 'conv_handoff_2' });
  expect(match).toBe('exact');
  expect(snapshot?.reason).toBe('upset caller');
  expect(snapshot?.from).toBe('+15557778888');
  expect(snapshot?.transcript).toEqual([
    { role: 'user', text: 'I need a person, now' },
    { role: 'assistant', text: 'Putting you through.' },
  ]);

  forgetHandoffSnapshot('conv_handoff_2');
});

test('a handoff BEATS a pending end_call, and only one frame is sent', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['One moment.'], 'One moment.', events);
  const rec = recordingSender();
  const session = liveSession('conv_handoff_3');

  // Both intents pending at once. Two `{type:'end'}` frames on one socket is undefined behaviour, and
  // hanging up on someone who just asked for a human is the worst available outcome.
  await requestEndCall('conv_handoff_3');
  await handoffTool({
    tac: fakeTac(),
    sessions: { getConversationSession: () => session as never },
  }).execute({ reason: 'caller asked for a person' }, {
    conversationId: 'conv_handoff_3',
    logger: silentLogger,
    profileId: 'profile_voice',
  });

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_3',
      transcript: 'get me a human',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
  );

  expect(rec.frames).toHaveLength(1);
  expect(JSON.parse(rec.frames[0] ?? '{}').handoffData).toBeTypeOf('string');
  expect(events.some((e) => e.kind === 'handoff')).toBe(true);
  expect(events.some((e) => e.kind === 'voice.end')).toBe(false);

  forgetHandoffSnapshot('conv_handoff_3');
});

test('the action URL is pinned, non-empty, and points at a path we own', () => {
  const opts = buildVoiceTwimlOptions('demo.ngrok.app');
  expect(opts.reportInputDuringAgentSpeech).toBe('any');
  expect(opts.actionUrl).toBe(`https://demo.ngrok.app${VOICE_ACTION_PATH}`);
  // Probe E in the design doc: `actionUrl: ''` silently DELETES the attribute and does not throw,
  // because VoiceChannelConfig is a plain interface and TwiMLOptionsSchema never runs on it.
  expect(opts.actionUrl.length).toBeGreaterThan(0);
  expect(() => buildVoiceTwimlOptions('')).toThrow(/publicDomain/);
});
```

Also update the existing assertion at `tests/voice.test.ts:424` — replace
`expect(VOICE_TWIML_OPTIONS.reportInputDuringAgentSpeech).toBe('any')` with
`expect(buildVoiceTwimlOptions('example.test').reportInputDuringAgentSpeech).toBe('any')`, and change
the import on line 19 from `VOICE_TWIML_OPTIONS` to `buildVoiceTwimlOptions`.

Import the shared fake rather than redeclaring it:

```ts
import { fakeTac } from './helpers/fake-tac.ts';
```

`tests/helpers/fake-tac.ts` was created in Task 2. It is a helper, not a suite — `vitest.config.ts`
includes only `tests/**/*.test.ts`, so nothing there is collected as tests.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test -- tests/voice.test.ts`
Expected: FAIL — `buildVoiceTwimlOptions` is not exported.

- [ ] **Step 3: Replace `VOICE_TWIML_OPTIONS` with the builder**

In `server/twilio/voice.ts`, add to the imports:

```ts
import { VOICE_ACTION_PATH, type HandoffTranscriptTurn } from '../../shared/handoff.ts';
import { consumeHandoffRequest, forgetHandoffRequest } from './handoff.ts';
import { recordHandoffSnapshot } from '../handoff/snapshots.ts';
```

Replace lines 69-71 (the `VOICE_TWIML_OPTIONS` const) with:

```ts
/**
 * A FUNCTION now, not a constant, because the second key depends on the public host.
 *
 * ── `actionUrl`, AND WHY IT IS NOT OPTIONAL ─────────────────────────────────────────────────────
 *
 * This is the `<Connect action>` URL: where Twilio POSTs when the ConversationRelay session ends.
 * Left unset, `resolveActionUrl` falls through to Studio (when a flow SID is configured) or to TAC's
 * derived default `/conversation-relay-callback`. BOTH are wrong for a handoff:
 *
 *  - TAC's own route answers `text/plain "OK"`, never TwiML, and its
 *    `ConversationRelayCallbackPayloadSchema` has no `HandoffData` field — being a plain non-strict
 *    `z.object` it STRIPS it. So the POST arrives, the handoff is silently discarded, and the call is
 *    dropped.
 *  - Studio's own webhook works but takes the routing decision away from this process, so the
 *    zero-Studio-setup path (`<Dial><Client>`) becomes unreachable.
 *
 * `defaultTwimlOptions` is layer 2 of five in `resolveActionUrl`, and nothing sits between it and
 * Studio: layer 1 (`onInboundCallTwiml`) is never registered and layer 3 (host per-call) is always
 * undefined inbound because `TACServer` calls `handleIncomingCall(twimlRequest)` with no options. So
 * pinning here wins over Studio, which is what makes `POST /api/voice/relay-action` reachable.
 *
 * ── THE THROW IS THE POINT ──────────────────────────────────────────────────────────────────────
 *
 * `TwiMLOptionsSchema` declares `actionUrl: z.string().min(1)`, but `VoiceChannelConfig` is a plain
 * INTERFACE, so that validation never runs for `defaultTwimlOptions`. Measured: `actionUrl: ''`
 * silently removes the attribute and does NOT throw, and `as const` is no barrier either. An empty
 * public domain would therefore delete end-of-call routing with no error anywhere — so this asserts
 * at boot, where it is one loud line, rather than on a live call, where it is a dropped transfer.
 *
 * `reportInputDuringAgentSpeech` is unchanged and still the difference between a caller being able to
 * interrupt us and the agent going deaf. See the git history of this file for the May 2025 default
 * change that makes it mandatory.
 */
export function buildVoiceTwimlOptions(publicDomain: string): {
  readonly reportInputDuringAgentSpeech: 'any';
  readonly actionUrl: string;
} {
  if (publicDomain.trim() === '') {
    throw new Error(
      'buildVoiceTwimlOptions requires a non-empty publicDomain: an empty actionUrl silently deletes ' +
        'the action attribute without throwing, which drops every handoff',
    );
  }
  return {
    reportInputDuringAgentSpeech: 'any',
    // Scheme included, unlike `voicePublicDomain` — TAC builds `wss://` itself for the socket, but the
    // action URL is used verbatim.
    actionUrl: `https://${publicDomain}${VOICE_ACTION_PATH}`,
  };
}
```

In `server/twilio/tac.ts`, change the import on line 64 from `VOICE_TWIML_OPTIONS` to
`buildVoiceTwimlOptions`, and line 346 to:

```ts
      // Throws on an empty domain, which cannot happen here — `caps.voice` already required
      // `config.voice !== null`, and the schema rejects an empty string. Kept as an assertion because
      // the failure it guards is invisible: an empty actionUrl deletes the attribute silently.
      defaultTwimlOptions: buildVoiceTwimlOptions(config.voice.publicDomain),
```

⚠ `config.voice` is `AppConfig['voice'] | null`. Inside `if (caps.voice)` TypeScript does not narrow it
(the capability is a separate boolean), so this needs the same treatment the file already uses for
`config.twilio`: assert once at the top of the `if (caps.voice)` block with
`if (config.voice === null) throw new Error('caps.voice without config.voice')`, which is unreachable
and documents itself.

- [ ] **Step 4: Widen `VoicePrompt.session` and generalise the frame sender**

Replace `VoicePrompt.session` (lines 104) with:

```ts
  readonly session?:
    | {
        readonly profileId?: string | null;
        /**
         * The caller's address — a phone number on this channel. Read at drain time so the screen pop
         * can correlate on it, which is the only correlator the Studio path leaves us: its
         * `connect-call-to` widget cannot pass parameters to a client, and dialling a client mints a
         * new call leg with a new CallSid.
         */
        readonly authorInfo?: { readonly address?: string } | undefined;
        /**
         * TAC's parked handoff frame — a COMPLETE `{type:'end', handoffData}` message, not raw data.
         *
         * Read here rather than via a second `getConversationSession` lookup because TAC hands us the
         * LIVE object by reference, so the field its tool assigned is already visible on this payload.
         * MUTATED at drain time (deleted after sending), which is the one place this file writes to
         * TAC's state — deliberately, and for the same reason TAC's own drain does it: a frame sent
         * twice is undefined behaviour.
         */
        pendingHandoffData?: { readonly type: string; readonly handoffData: string } | undefined;
      }
    | undefined;
```

Note `pendingHandoffData` is NOT `readonly` — the drain deletes it.

Replace `endSession` (lines 174-188) with a general frame sender plus a thin wrapper, keeping every
word of the existing header comment above `endSession` in place:

```ts
/**
 * Send one ConversationRelay frame on the raw socket.
 *
 * Generalised from `endSession` at T14b, because handoff and `end_call` differ ONLY in the payload:
 * `{"type":"end"}` alone for a hangup, `{"type":"end","handoffData":"<json>"}` for a transfer. Both
 * end the session and return control of the call to Twilio, which then requests the `<Connect action>`
 * URL — the difference is entirely in what that route is told.
 */
function sendFrame(
  sender: VoiceSender,
  conversationId: string,
  frame: object,
  logger: ToolLogger,
): boolean {
  const ws = sender.getWebsocket(conversationId);
  if (ws === null || ws.readyState !== WS_OPEN) {
    // Normal, not an error: the caller may have hung up during the goodbye.
    logger.debug({ conversationId }, 'voice: no open socket to send the end frame — the call is already gone');
    return false;
  }
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (err) {
    logger.warn({ err, conversationId }, 'voice: could not send the end frame');
    return false;
  }
}

const endSession = (sender: VoiceSender, conversationId: string, logger: ToolLogger): boolean =>
  sendFrame(sender, conversationId, { type: 'end' }, logger);
```

- [ ] **Step 5: Replace the hangup block with handoff-then-hangup**

Replace lines 317-334 of `server/twilio/voice.ts` (the `══ THE HANGUP` block) with:

```ts
      // ══ THE TRANSFER AND THE HANGUP, IN THAT ORDER, AND THEY MUST BE LAST. ══
      //
      // Both tools only recorded an intent — see `../agent/tools/end-call.ts` and `./handoff.ts` for
      // why neither can act where it stands. By here the farewell has been streamed and its
      // `last: true` marker sent, so ending the session is the next thing the caller should
      // experience. Doing this earlier truncates the goodbye; doing it inside a tool truncates it
      // before it is even written.
      //
      // ══ TRANSFER WINS UNCONDITIONALLY. ══
      //
      // Two `{"type":"end"}` frames on one socket is undefined behaviour, so exactly one goes out.
      // Hanging up on someone who has just asked for a human is the worst available outcome, so the
      // parked handoff frame is checked FIRST and a pending `end_call` is dropped, not queued.
      const handoffReason = consumeHandoffRequest(conversationId);
      if (handoffReason !== null) {
        forgetEndCallRequest(conversationId);

        /**
         * SNAPSHOT BEFORE THE FRAME GOES OUT, and this is the only moment it can be taken.
         *
         * `handleVoiceDisconnect` calls `history.clear()` when the socket closes, and the socket closes
         * BECAUSE we are about to send this frame. Taking it here rather than inside the tool is also
         * what makes it complete: `run-turn.ts` appends the user+assistant pair at the END of the turn,
         * before `done` resolves, so by this line history holds the caller's request AND the farewell.
         * Inside the tool it would hold neither.
         *
         * A snapshot failure must NOT block the transfer — the screen pop degrades to reason-only,
         * which is still a working handoff. Hence the try/catch around the store and not around the
         * send.
         */
        try {
          const transcript: HandoffTranscriptTurn[] = turn.history
            .read(conversationId)
            .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
            .map((m) => ({ role: m.role, text: m.content }));
          recordHandoffSnapshot({
            conversationId,
            reason: handoffReason,
            from: params.session?.authorInfo?.address ?? null,
            at: new Date().toISOString(),
            transcript,
          });
        } catch (err) {
          logger.warn({ err, conversationId }, 'voice: could not snapshot the transcript for the screen pop');
        }

        /**
         * THE FIVE LINES TAC OMITS HERE.
         *
         * `session.pendingHandoffData` is a complete frame, and TAC's own drain is five lines sitting
         * inside `sendResponse` (`dist/index.js:5245-5254`). `sendStreamingResponse` — which is what
         * this channel uses on every turn — has ZERO references to the field, so on a streaming app the
         * parked frame is never sent at all. TAC's own streaming example never drains it either.
         *
         * Falling back to a plain `{type:'end'}` is deliberate: if the tool succeeded but the frame is
         * somehow absent, ending the session still returns control to Twilio and our action route still
         * answers — the caller reaches a human without the payload rather than sitting on a dead line.
         */
        const parked = params.session?.pendingHandoffData;
        const sent = sendFrame(sender, conversationId, parked ?? { type: 'end' }, logger);
        if (parked !== undefined && params.session !== undefined) {
          // Exactly what TAC's drain does, and for the same reason: a frame sent twice is undefined
          // behaviour, and TAC reuses a conversation id per profile.
          delete params.session.pendingHandoffData;
        }

        turn.obs.publish({
          kind: 'handoff',
          summary: sent
            ? `transferred to a human: ${handoffReason}`
            : `tried to transfer but the socket was gone: ${handoffReason}`,
          channel: 'voice',
          conversationId,
          payload: {
            reason: handoffReason,
            frameSent: sent,
            hadPayload: parked !== undefined,
            farewell: spoken,
          },
        });
        return;
      }

      const endReason = consumeEndCallRequest(conversationId);
      if (endReason !== null) {
        const sent = endSession(sender, conversationId, logger);
        turn.obs.publish({
          kind: 'voice.end',
          summary: sent ? `agent ended the call: ${endReason}` : `agent tried to end the call but the socket was gone: ${endReason}`,
          channel: 'voice',
          conversationId,
          payload: { reason: endReason, frameSent: sent, farewell: spoken },
        });
      }
```

- [ ] **Step 6: Clear the intent on the two other endings**

In `handleVoicePrompt`'s barge-in branch (line 295), add beside `forgetEndCallRequest`:

```ts
        // Same argument as the hangup: interrupting the "putting you through" line is how a caller says
        // "wait, no". Honouring a queued transfer here would send them to a human mid-objection.
        forgetHandoffRequest(conversationId);
```

⚠ This leaves `session.pendingHandoffData` parked, and that is correct rather than a leak: TAC's own
drain in `sendResponse` would send it if a later turn used that path, and the conversation is already
`INACTIVE`. Add that sentence as a comment so the asymmetry is not later "fixed".

In `handleVoiceDisconnect` (line 442), add after `forgetEndCallRequest(conversationId)`:

```ts
  // The INTENT only. The SNAPSHOT deliberately survives — this handler fires the moment the socket
  // closes, which is seconds BEFORE a human presses answer, so clearing it here would make the screen
  // pop reliably empty on the one path it exists for. `server/handoff/snapshots.ts` bounds it instead.
  forgetHandoffRequest(conversationId);
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test -- tests/voice.test.ts tests/handoff.test.ts`
Expected: PASS. The four new voice tests plus the ten handoff tests.

- [ ] **Step 8: Verify the whole suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, ~306 tests.

- [ ] **Step 9: Commit**

```bash
git add server/twilio/voice.ts server/twilio/tac.ts tests/voice.test.ts
git commit -m "T14b.3: drain the parked frame after the farewell, and pin the action URL at a path we own"
```

---

### Task 4: The action route — where the call is actually routed

The frame now goes out and Twilio POSTs us. This route decides where the caller lands, and **must return
valid TwiML on every path** — a throw here is a dropped call.

**Files:**
- Create: `server/http/routes-voice-action.ts`
- Modify: `server/http/app.ts` (register it), `server/twilio/tac.ts` (register `@fastify/formbody`)
- Test: `tests/voice-action.test.ts`

**Interfaces:**
- Consumes: `VOICE_ACTION_PATH`, `CLIENT_IDENTITY` (Task 1); `AppConfig`, `Capabilities` from `server/config.ts`; `ObsBus`.
- Produces: `registerVoiceActionRoutes(app: App, deps: { config: AppConfig; caps: Capabilities; bus: ObsBus }): void`, and for direct unit testing `buildActionTwiml(input: { handoffData: string | undefined; accountSid: string | null; flowSid: string | null }): ActionTwimlResult` where `interface ActionTwimlResult { twiml: string; route: 'studio' | 'client' | 'hangup'; conversationId: string | null; reasonCode: string | null }` — also exported, because Task 6's tests and any later console work read `route` and `reasonCode`.

**The payload, confirmed against Twilio's documentation** — `<ConversationRelay>` action URL callback:
`AccountSid`, `CallSid`, `CallStatus`, `From`, `To`, `Direction`, `ApplicationSid`, `SessionId`,
`SessionStatus` (`ended` | `completed` | `failed`), `SessionDuration`, and `HandoffData` (a JSON-encoded
**string**) when the application ended the session. On failure it carries `ErrorCode` / `ErrorMessage`
instead; on a caller hangup, `SessionStatus: completed` and **no** `HandoffData`.

- [ ] **Step 1: Declare the form-body parser**

Run:

```bash
pnpm add @fastify/formbody
```

Twilio POSTs `application/x-www-form-urlencoded`, and Fastify parses only JSON out of the box. TAC does
register `@fastify/formbody` inside `start()` — but guarded by `hasContentTypeParser`, and only when TAC
boots. Registering it ourselves makes the route testable with `app.inject` and independent of boot
order; TAC's guard then sees it present and skips.

In `server/twilio/tac.ts`, beside the existing `await app.register(gracefulShutdown, ...)`:

```ts
import formbody from '@fastify/formbody';

  // ...after the gracefulShutdown registration:
  /**
   * OURS, FIRST, AND AWAITED — the same three requirements as `gracefulShutdown` above, for a related
   * reason. TAC registers this itself inside `start()` behind
   * `if (!this.fastify.hasContentTypeParser('application/x-www-form-urlencoded'))`. Registering
   * WITHOUT awaiting would leave the parser still queued when that check runs, TAC would register its
   * own copy, and the second registration throws `FST_ERR_CTP_ALREADY_PRESENT`.
   *
   * Needed because `POST /api/voice/relay-action` is ours, not TAC's, and Twilio posts form-encoded
   * bodies. Declared as a direct dependency rather than relied on as TAC's transitive one — an
   * undeclared import is the trap `docs/HANDOFF.md` records for the `twilio` package.
   */
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await app.register(formbody);
  }
```

- [ ] **Step 2: Write the failing tests**

Create `tests/voice-action.test.ts`:

```ts
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { buildActionTwiml, registerVoiceActionRoutes } from '../server/http/routes-voice-action.ts';
import { capabilities, loadConfig } from '../server/config.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { VOICE_ACTION_PATH, CLIENT_IDENTITY } from '../shared/handoff.ts';
import type { App } from '../server/http/types.ts';
import type { ObsEvent } from '../shared/events.ts';

const ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const FLOW_SID = 'FW' + 'b'.repeat(32);
const handoffData = JSON.stringify({
  conversationId: 'conv_action_1',
  storeId: 'store_x',
  profileId: 'profile_x',
  attributes: { reasonCode: 'live-agent-handoff', reason: 'caller asked for a person' },
});

test('with a flow SID configured it redirects to Studio', () => {
  const { twiml, route } = buildActionTwiml({ handoffData, accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('studio');
  // TAC's own `studioVoiceHandoffUrl` shape, written out here because this module may not import TAC.
  expect(twiml).toContain(
    `https://webhooks.twilio.com/v1/Accounts/${ACCOUNT_SID}/Flows/${FLOW_SID}?Trigger=incomingCall`,
  );
  expect(twiml).toContain('<Redirect method="POST">');
});

test('with no flow SID it dials the browser client and carries the conversation id', () => {
  const { twiml, route } = buildActionTwiml({ handoffData, accountSid: ACCOUNT_SID, flowSid: null });
  expect(route).toBe('client');
  expect(twiml).toContain(`<Identity>${CLIENT_IDENTITY}</Identity>`);
  // The ONLY path that gets exact screen-pop correlation, because it is the only one that can: the
  // Studio connect-call-to widget cannot pass parameters to a client.
  expect(twiml).toContain('<Parameter name="conversationId" value="conv_action_1"/>');
  expect(twiml).toContain('answerOnBridge="true"');
  // A no-answer must not leave the call in limbo after the dial times out.
  expect(twiml.indexOf('</Dial>')).toBeLessThan(twiml.indexOf('<Hangup/>'));
});

test('no HandoffData means the end_call path, which hangs up cleanly', () => {
  const { twiml, route } = buildActionTwiml({ handoffData: undefined, accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('hangup');
  expect(twiml).toContain('<Hangup/>');
  expect(twiml).not.toContain('Redirect');
});

test('UNPARSEABLE HandoffData hangs up rather than throwing', () => {
  // A throw here is a dropped call with a TwiML error in the debugger. This is the assertion that
  // keeps the route's promise — valid TwiML on EVERY path.
  const { twiml, route } = buildActionTwiml({ handoffData: 'not json{{{', accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('hangup');
  expect(twiml).toContain('<Hangup/>');
});

test('a missing account SID cannot produce a half-built Studio URL', () => {
  // Falls back to the client path rather than emitting `Accounts/null/Flows/...`, which Twilio would
  // answer with a 404 the caller experiences as silence.
  const { route } = buildActionTwiml({ handoffData, accountSid: null, flowSid: FLOW_SID });
  expect(route).toBe('client');
});

test('the route answers XML with a 200 and publishes one handoff event', async () => {
  const events: ObsEvent[] = [];
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));

  const app = Fastify() as unknown as App;
  await app.register(formbody);
  const config = loadConfig({
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_API_KEY: 'SK' + 'c'.repeat(32),
    TWILIO_API_SECRET: 'secret',
    TWILIO_PHONE_NUMBER: '+15550001111',
    TWILIO_VOICE_PUBLIC_DOMAIN: 'demo.test',
    TWILIO_CONVERSATION_CONFIGURATION_ID: 'conv_configuration_' + 'a'.repeat(26),
    TWILIO_STUDIO_HANDOFF_FLOW_SID: FLOW_SID,
  });
  registerVoiceActionRoutes(app, { config, caps: capabilities(config), bus });

  const res = await app.inject({
    method: 'POST',
    url: VOICE_ACTION_PATH,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      AccountSid: ACCOUNT_SID,
      CallSid: 'CA' + 'd'.repeat(32),
      CallStatus: 'in-progress',
      From: '+15557778888',
      To: '+15550001111',
      SessionStatus: 'ended',
      SessionDuration: '25',
      HandoffData: handoffData,
    }).toString(),
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/xml');
  expect(res.body).toContain('<Redirect method="POST">');
  const published = events.find((e) => e.kind === 'handoff');
  expect(published?.payload).toMatchObject({ route: 'studio', reasonCode: 'live-agent-handoff' });
  await app.close();
});

test('a failed session is logged and hung up, not redirected', async () => {
  const bus = createObsBus();
  const app = Fastify() as unknown as App;
  await app.register(formbody);
  const config = loadConfig({ TWILIO_STUDIO_HANDOFF_FLOW_SID: FLOW_SID });
  registerVoiceActionRoutes(app, { config, caps: capabilities(config), bus });

  const res = await app.inject({
    method: 'POST',
    url: VOICE_ACTION_PATH,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      SessionStatus: 'failed',
      ErrorCode: '64105',
      ErrorMessage: 'WebSocket Ended',
    }).toString(),
  });

  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<Hangup/>');
  await app.close();
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm test -- tests/voice-action.test.ts`
Expected: FAIL — `Cannot find module '../server/http/routes-voice-action.ts'`.

- [ ] **Step 4: Write the route**

Create `server/http/routes-voice-action.ts`:

```ts
/**
 * `POST /api/voice/relay-action` — the `<Connect action>` URL, and the one place the call is routed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS ROUTE RETURNS VALID TwiML ON EVERY PATH, INCLUDING THE ONES THAT ARE BUGS.
 *
 * A throw here is a dropped call plus a TwiML error in the Twilio debugger — the caller hears silence
 * and nothing says why. So unparseable `HandoffData` answers `<Hangup/>` with a loud log rather than a
 * 500, and a half-configured account falls back to a path that works rather than emitting a URL Twilio
 * will 404.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS ROUTE EXISTS AT ALL, rather than pointing `actionUrl` at Studio or leaving TAC's default:
 * TAC's `/conversation-relay-callback` is TAC's OWN route, it answers `text/plain "OK"` and never
 * TwiML, and its payload schema has no `HandoffData` field — being a plain non-strict `z.object` it
 * STRIPS it. So the handoff would arrive and be silently discarded. Design doc §2.1.
 *
 * NO TWILIO SIGNATURE VALIDATION, stated rather than hidden. Validation needs `validateRequest` from
 * the `twilio` package, which `tests/architecture.test.ts` confines to `server/twilio/`. The exposure
 * is small and worth naming precisely: an unauthenticated POST here returns routing TwiML and nothing
 * else — no account data, no token, no side effect beyond one obs event. It cannot place a call; only
 * Twilio executing TwiML for a call that already reached us can. If this ever needs signing, inject a
 * validator from `server/twilio/` the way `mintToken` is injected in `./routes-handoff.ts`.
 */
import { z } from 'zod';
import { CLIENT_IDENTITY, VOICE_ACTION_PATH } from '../../shared/handoff.ts';
import type { AppConfig, Capabilities } from '../config.ts';
import { childLogger } from '../logging.ts';
import type { ObsBus } from '../obs/bus.ts';
import { maskPhone } from '../obs/pii.ts';
import type { App } from './types.ts';

const log = childLogger('voice-action');

/** How long to ring the browser before giving up. Twilio's default is 30 s; stated so it is tunable. */
const DIAL_TIMEOUT_SECONDS = 30;

/**
 * Non-strict on purpose: Twilio adds fields to this callback over time (`ApplicationSid` and
 * `SessionDuration` were not in the first version of the docs), and a `.strict()` schema would turn a
 * Twilio addition into a dropped call. Every field is optional because the three documented payload
 * shapes — ended, completed, failed — each omit some of them.
 */
const ActionBody = z.object({
  CallSid: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  CallStatus: z.string().optional(),
  SessionStatus: z.string().optional(),
  SessionDuration: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
  /** A JSON-encoded STRING, per Twilio. The double encoding is the documented contract, not a defect. */
  HandoffData: z.string().optional(),
});

/** XML-escape a value going into an attribute or a text node. */
const xml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const hangup = (): string => `${DECLARATION}<Response><Hangup/></Response>`;

/**
 * The Studio voice webhook URL.
 *
 * Written out rather than imported from TAC's `studioVoiceHandoffUrl(accountSid, flowSid)` — which
 * produces this exact string — because this module may not import `twilio-agent-connect`. Kept
 * byte-identical, and `tests/voice-action.test.ts` pins it, so a TAC change to the shape is a visible
 * test failure rather than a silent divergence.
 *
 * `Trigger=incomingCall` is what makes Studio start a voice execution. Note the flow receives NO
 * handoff data: a `<Redirect>` starts a FRESH incoming-call execution, whose trigger variables are the
 * fixed Call-resource set, so a custom query parameter would not resolve. The screen pop gets its data
 * from `GET /api/handoff/context` instead — see the plan's correction C7.
 */
const studioUrl = (accountSid: string, flowSid: string): string =>
  `https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${flowSid}?Trigger=incomingCall`;

/**
 * Dial the browser client directly — the zero-Studio-setup path, so a fresh clone works with no
 * account configuration beyond the softphone being open.
 *
 * `answerOnBridge="true"` so the caller keeps hearing ringing until the human actually answers, rather
 * than going silent the moment Twilio starts dialling.
 *
 * `<Parameter>` inside `<Client>` is what the Voice SDK surfaces as `call.customParameters`, and it is
 * the ONLY exact correlator available anywhere in this feature. `<Hangup/>` after `</Dial>` covers the
 * no-answer case: without it, a timed-out dial falls off the end of the document and the caller sits
 * on an open line.
 */
const dialClient = (conversationId: string | null): string =>
  `${DECLARATION}<Response>` +
  `<Dial answerOnBridge="true" timeout="${DIAL_TIMEOUT_SECONDS}">` +
  `<Client><Identity>${xml(CLIENT_IDENTITY)}</Identity>` +
  (conversationId === null ? '' : `<Parameter name="conversationId" value="${xml(conversationId)}"/>`) +
  `</Client></Dial><Hangup/></Response>`;

export interface ActionTwimlResult {
  readonly twiml: string;
  readonly route: 'studio' | 'client' | 'hangup';
  readonly conversationId: string | null;
  readonly reasonCode: string | null;
}

/**
 * The whole decision, as a pure function, so every branch is testable without a socket.
 *
 * Exported for that reason alone — the route handler below is a thin wrapper that parses, calls this,
 * publishes and replies.
 */
export function buildActionTwiml(input: {
  readonly handoffData: string | undefined;
  readonly accountSid: string | null;
  readonly flowSid: string | null;
}): ActionTwimlResult {
  if (input.handoffData === undefined || input.handoffData === '') {
    /**
     * The `end_call` path, and a DELIBERATE BEHAVIOUR CHANGE. Today TAC answers this callback with
     * `text/plain "OK"`, Twilio gets nothing actionable and drops the call; `docs/HANDOFF.md` records
     * that no alert is raised and says not to "fix" it. Owning the route makes returning TwiML
     * unavoidable, and `<Hangup/>` is the cleaner disposition — but it IS a change on a working path
     * and the verification ladder re-tests the plain hangup because of it.
     */
    return { twiml: hangup(), route: 'hangup', conversationId: null, reasonCode: null };
  }

  let payload: { conversationId?: unknown; attributes?: { reasonCode?: unknown } };
  try {
    payload = JSON.parse(input.handoffData) as typeof payload;
  } catch {
    // Loud, because it means the frame and this parser disagree — a code bug, not a caller action.
    log.error(
      { handoffDataLength: input.handoffData.length },
      'voice-action: HandoffData was not valid JSON, so the call is being hung up rather than routed',
    );
    return { twiml: hangup(), route: 'hangup', conversationId: null, reasonCode: null };
  }

  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
  const reasonCode = typeof payload.attributes?.reasonCode === 'string' ? payload.attributes.reasonCode : null;

  // Both halves required, or the URL is `Accounts/null/Flows/...` — a Twilio 404 the caller experiences
  // as silence. Falling back to the client path is strictly better than emitting a broken redirect.
  if (input.flowSid !== null && input.accountSid !== null) {
    return {
      twiml: `${DECLARATION}<Response><Redirect method="POST">${xml(studioUrl(input.accountSid, input.flowSid))}</Redirect></Response>`,
      route: 'studio',
      conversationId,
      reasonCode,
    };
  }

  return { twiml: dialClient(conversationId), route: 'client', conversationId, reasonCode };
}

export function registerVoiceActionRoutes(
  app: App,
  deps: { readonly config: AppConfig; readonly caps: Capabilities; readonly bus: ObsBus },
): void {
  /**
   * NO CAPABILITY GATE, unlike every other route in this directory. Twilio is already executing TwiML
   * for a live call by the time it reaches here; answering 503 would drop that call. The capability
   * question — is a Studio flow configured? — is a ROUTING decision, not an availability one, and
   * `buildActionTwiml` makes it.
   */
  app.post(VOICE_ACTION_PATH, (request, reply) => {
    const parsed = ActionBody.safeParse(request.body ?? {});
    const body = parsed.success ? parsed.data : {};
    if (!parsed.success) {
      // Cannot happen with every field optional, but a schema edit could make it possible, and the
      // consequence would be a dropped call. Logged rather than thrown.
      log.warn({ url: request.url }, 'voice-action: could not parse the action callback body');
    }

    if (body.SessionStatus === 'failed') {
      // ConversationRelay itself failed — 64105 "WebSocket Ended" is the common one. There is nothing
      // to route to, and the error codes are the only diagnosis available for a call the caller
      // experienced as a dropped line.
      log.error(
        { errorCode: body.ErrorCode ?? null, errorMessage: body.ErrorMessage ?? null, callSid: body.CallSid ?? null },
        'voice-action: the ConversationRelay session FAILED, so the call is being hung up',
      );
      deps.bus.publish({
        kind: 'error',
        summary: `ConversationRelay session failed: ${body.ErrorCode ?? '?'} ${body.ErrorMessage ?? ''}`.trim(),
        channel: 'voice',
        payload: { errorCode: body.ErrorCode ?? null, errorMessage: body.ErrorMessage ?? null },
      });
      void reply.code(200).type('text/xml').send(hangup());
      return;
    }

    const result = buildActionTwiml({
      handoffData: body.HandoffData,
      accountSid: deps.config.twilio?.accountSid ?? null,
      flowSid: deps.config.studioHandoffFlowSid,
    });

    if (result.route !== 'hangup') {
      deps.bus.publish({
        kind: 'handoff',
        // `summary` is copied VERBATIM by the bus — only `payload` is scrubbed — so the number is
        // masked here, the same rule `./app.ts` and `../twilio/messaging.ts` follow.
        summary: `routing the transferred call to ${result.route} for ${maskPhone(body.From ?? 'unknown')}`,
        channel: 'voice',
        ...(result.conversationId !== null && { conversationId: result.conversationId }),
        payload: {
          route: result.route,
          reasonCode: result.reasonCode,
          sessionStatus: body.SessionStatus ?? null,
          sessionDurationSeconds: body.SessionDuration ?? null,
          callSid: body.CallSid ?? null,
          from: body.From ?? null,
          identity: result.route === 'client' ? CLIENT_IDENTITY : null,
        },
      });
    }

    /**
     * `text/xml`, not `application/xml`. Both work, and Twilio's own examples use `text/xml` — the
     * value matters only because a JSON content type makes Twilio report a TwiML parse error rather
     * than executing the document.
     */
    void reply.code(200).type('text/xml').send(result.twiml);
  });
}
```

- [ ] **Step 5: Register it**

In `server/http/app.ts`, add the import and the registration beside the bench routes:

```ts
import { registerVoiceActionRoutes } from './routes-voice-action.ts';

  // ...after `const bench = registerBenchRoutes(...)`:
  // Registered unconditionally and with no capability gate — Twilio is mid-call by the time it POSTs
  // here, so a 404 or a 503 is a dropped call. See the route's own header.
  registerVoiceActionRoutes(app, { config, caps, bus: obsBus });
```

While in this file, correct the now-stale fixture comment at lines 162-169: `handoff` is a real tool as
of T14b, so the `/api/dev/emit-turn` fixture's `unavailable: ['handoff']` no longer illustrates an
unavailable tool the way it did. Change the fixture to keep its meaning:

```ts
        // The real catalog (`server/agent/tools/catalog.ts`), so this fixture teaches the tools a
        // reader will actually find. `handoff` became a REAL tool at T14b; it is still the right
        // fixture for the `unavailable` bucket because it is the one tool that genuinely lands there
        // on a process with no Studio flow SID configured.
        considered: ['lookup_order', 'get_store_hours', 'handoff'],
        resolved: ['lookup_order', 'get_store_hours'],
        unknown: [],
        unavailable: ['handoff'],
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- tests/voice-action.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Verify the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, ~313 tests.

- [ ] **Step 8: Prove it on the real process (free — no call placed)**

This is rung 2 of the spec's verification ladder and the single highest-value check in the plan: it
proves the five-layer `actionUrl` precedence on the live process rather than on a probe.

```bash
pnpm dev   # in another shell; wait for "tac: listening"
```

Then POST a signed `/twiml` request the way `scripts/verify-*.ts` do, and read the attribute:

```bash
curl -s -X POST "http://localhost:8910/twiml" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'CallSid=CAtest&From=%2B15557778888&To=%2B15550001111&Direction=inbound&CallStatus=ringing' \
  | tee /tmp/twiml.xml
```

Expected in `/tmp/twiml.xml`, all four at once:
- `action="https://<your public domain>/api/voice/relay-action"`
- **no** `webhooks.twilio.com` anywhere (this is what proves we beat Studio, layer 2 over layer 4)
- `reportInputDuringAgentSpeech="any"` still present
- the `conversationConfiguration` attribute still present

⚠ If `/twiml` answers 403, that is Twilio signature validation, not a bug in this task — TAC validates
its own routes. Use `twil webhook invoke` to send a properly signed simulated webhook instead, which
costs nothing.

Then prove both routing branches, still free:

```bash
# Studio branch (with TWILIO_STUDIO_HANDOFF_FLOW_SID set in .env)
curl -s -X POST "http://localhost:8910/api/voice/relay-action" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'SessionStatus=ended' \
  --data-urlencode 'From=+15557778888' \
  --data-urlencode 'HandoffData={"conversationId":"conv_probe","storeId":"s","profileId":"p","attributes":{"reasonCode":"live-agent-handoff","reason":"probe"}}'

# The unparseable path — must be <Hangup/>, never a 500
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:8910/api/voice/relay-action" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'HandoffData=not json{{{'
```

Expected: the first prints a `<Redirect>` to `webhooks.twilio.com/...Trigger=incomingCall`; the second
prints `200`. Comment out the flow SID in `.env`, restart, and re-run the first to see the
`<Dial><Client>` branch.

- [ ] **Step 9: Commit**

```bash
git add server/http/routes-voice-action.ts server/http/app.ts server/twilio/tac.ts \
        tests/voice-action.test.ts package.json pnpm-lock.yaml
git commit -m "T14b.4: the action route we own — TwiML on every path, both routing branches"
```

---

### Task 5: Mint the Voice SDK token

Rung 4 of the ladder needs a registered client before any transfer can be demonstrated, so the
softphone half starts here. **No account mutation is required** — a TwiML Application is an
OUTGOING-only requirement, and `incomingAllow: true` is what permits receiving.

**Files:**
- Create: `server/twilio/voice-token.ts`
- Create: `server/http/routes-handoff.ts` (token route now; the context route in Task 6)
- Modify: `server/http/app.ts`, `server/index.ts`
- Test: `tests/handoff-http.test.ts`

**Interfaces:**
- Consumes: `CLIENT_IDENTITY`, `VOICE_TOKEN_PATH` (Task 1); `AppConfig`, `Capabilities`, `unavailable`.
- Produces:
  - `server/twilio/voice-token.ts`: `mintVoiceToken(deps: { accountSid: string; apiKey: string; apiSecret: string; identity: string; ttlSeconds?: number }): string`, `VOICE_TOKEN_TTL_SECONDS`.
  - `server/http/routes-handoff.ts`: `type MintToken = (identity: string) => string`, `registerHandoffRoutes(app: App, deps: { config: AppConfig; caps: Capabilities; mintToken?: MintToken }): HandoffRoutes` where `interface HandoffRoutes { setMintToken(mint: MintToken): void }`.

- [ ] **Step 1: Add the dependency, pinned**

```bash
pnpm add twilio@5.13.1
```

**Exactly 5.13.1, not `^5`.** TAC declares `twilio: ^5.10.7` and pnpm has already resolved it to
5.13.1 in the store, so this exact pin **dedupes with TAC's copy** instead of installing a second
Twilio SDK. `twilio` is currently reachable only as TAC's unhoisted transitive dependency, which means
`AccessToken` is unimportable today — an undeclared import is the trap to avoid, not a shortcut.

⚠ The repo's 7-day supply-chain guard is **not enforced** (pnpm 11.8 does not read
`minimum-release-age` from `.npmrc`, and `pnpm-workspace.yaml` has no `minimumReleaseAge`). Reported,
not policed: 5.13.1 is already in the lockfile via TAC, so this adds no new code to the tree.

- [ ] **Step 2: Write the failing test**

Create `tests/handoff-http.test.ts`:

```ts
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { capabilities, loadConfig } from '../server/config.ts';
import { registerHandoffRoutes } from '../server/http/routes-handoff.ts';
import { mintVoiceToken } from '../server/twilio/voice-token.ts';
import { CLIENT_IDENTITY, VOICE_TOKEN_PATH } from '../shared/handoff.ts';
import type { App } from '../server/http/types.ts';

const ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const API_KEY = 'SK' + 'c'.repeat(32);

const fullEnv = {
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_API_KEY: API_KEY,
  TWILIO_API_SECRET: 'secret',
  TWILIO_PHONE_NUMBER: '+15550001111',
  TWILIO_VOICE_PUBLIC_DOMAIN: 'demo.test',
};

test('the minted token is a JWT granting incoming voice to our identity', () => {
  const jwt = mintVoiceToken({
    accountSid: ACCOUNT_SID,
    apiKey: API_KEY,
    apiSecret: 'secret',
    identity: CLIENT_IDENTITY,
  });

  const [header, claims] = jwt.split('.');
  expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({ typ: 'JWT', alg: 'HS256' });
  const decoded = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());

  // The identity is the whole contract with the flow and the page — and it must have NO hyphen.
  expect(decoded.grants.identity).toBe('browser_agent');
  expect(decoded.grants.identity).not.toContain('-');
  // `incomingAllow` is what permits RECEIVING. `outgoingApplicationSid` is deliberately absent: that
  // is the only thing a TwiML Application would be needed for, and we do not place calls from here.
  expect(decoded.grants.voice.incoming.allow).toBe(true);
  expect(decoded.grants.voice.outgoing).toBeUndefined();
  expect(decoded.iss).toBe(API_KEY);
  expect(decoded.sub).toBe(ACCOUNT_SID);
});

test('the token route returns a token and echoes the identity', async () => {
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  const routes = registerHandoffRoutes(app, { config, caps: capabilities(config) });
  routes.setMintToken((identity) =>
    mintVoiceToken({ accountSid: ACCOUNT_SID, apiKey: API_KEY, apiSecret: 'secret', identity }),
  );

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.identity).toBe(CLIENT_IDENTITY);
  expect(typeof body.token).toBe('string');
  expect(body.ttlSeconds).toBeGreaterThan(0);
  await app.close();
});

test('an unconfigured process 503s NAMING the variable, and never returns a token', async () => {
  // The house degradation contract. A softphone that gets `{token: undefined}` fails inside the SDK
  // with a message about the token, which sends the reader to the wrong file.
  const app = Fastify() as unknown as App;
  const config = loadConfig({});
  registerHandoffRoutes(app, { config, caps: capabilities(config) });

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(503);
  const body = res.json();
  expect(body.error).toBe('not_configured');
  expect(JSON.stringify(body.missing)).toContain('TWILIO_ACCOUNT_SID');
  expect(body.token).toBeUndefined();
  await app.close();
});

test('a configured process whose minter was never injected 503s rather than 500s', async () => {
  // Reachable in exactly one real state: Twilio config present but `bootTac` threw, so `server/index.ts`
  // degraded without injecting. The page must be told, not handed a stack trace.
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  registerHandoffRoutes(app, { config, caps: capabilities(config) });

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toBe('not_configured');
  await app.close();
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm test -- tests/handoff-http.test.ts`
Expected: FAIL — `Cannot find module '../server/twilio/voice-token.ts'`.

- [ ] **Step 4: Write the minter**

Create `server/twilio/voice-token.ts`:

```ts
/**
 * The Voice SDK AccessToken — the only new file in the repo that imports the raw `twilio` package.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT LIVES HERE BECAUSE OF AN ARCHITECTURE RULE, NOT A PREFERENCE.
 *
 * `tests/architecture.test.ts` confines `twilio` to `server/twilio/` and `scripts/`, for the same
 * reason it confines `twilio-agent-connect`. The design doc put this in `server/http/`, which would
 * fail the build. `server/http/routes-handoff.ts` therefore receives a `mintToken` FUNCTION injected
 * at boot — so a process with no Twilio credentials never loads this module, and never loads `twilio`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO API PERMISSION IS REQUIRED to mint one of these: it is a locally signed JWT, and the exported key
 * carries the `signing` flag. This matters because the long-standing 70004 on `accounts list` looks
 * like a restricted key and is not — that error is the absence of `manage_keys`/`manage_accounts`.
 * Nothing here makes a network call, which is also why it is trivially testable.
 *
 * NO TwiML APPLICATION, and this is the field that proves it: `outgoingApplicationSid` is optional in
 * `VoiceGrantOptions`, and a TwiML App is an OUTGOING-only requirement. `incomingAllow: true` is what
 * permits RECEIVING a call. So the softphone needs zero account mutations. Three TwiML Applications do
 * exist on this account; none belongs to this scaffold.
 *
 * TAC will not do this for us — its dist contains ZERO `AccessToken` references.
 */
import twilio from 'twilio';

/**
 * One hour, which is Twilio's own default and long enough for a demo without a refresh dance.
 *
 * The page re-fetches on `tokenWillExpire` regardless, because a token that expires mid-demo takes the
 * softphone offline silently — the Device stops registering and nothing on screen says why.
 */
export const VOICE_TOKEN_TTL_SECONDS = 3600;

export interface MintVoiceTokenDeps {
  readonly accountSid: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** `CLIENT_IDENTITY`. Passed rather than imported so a test can prove the charset rule. */
  readonly identity: string;
  readonly ttlSeconds?: number;
}

export function mintVoiceToken(deps: MintVoiceTokenDeps): string {
  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(deps.accountSid, deps.apiKey, deps.apiSecret, {
    identity: deps.identity,
    ttl: deps.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS,
  });

  token.addGrant(
    new VoiceGrant({
      // The whole grant. See the header on why there is no `outgoingApplicationSid`.
      incomingAllow: true,
    }),
  );

  return token.toJwt();
}
```

- [ ] **Step 5: Write the token route**

Create `server/http/routes-handoff.ts`:

```ts
/**
 * The two routes the softphone page calls.
 *
 * `POST /api/voice/token`   — a Voice SDK AccessToken for `CLIENT_IDENTITY`
 * `GET  /api/handoff/context` — the screen pop (added in the next task)
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE MUST NOT IMPORT `twilio` OR `twilio-agent-connect`.
 *
 * `tests/architecture.test.ts` confines both to `server/twilio/`. The minter is therefore INJECTED:
 * `server/index.ts` calls `setMintToken` at the same point it boots TAC, which also means a process
 * with no Twilio credentials never loads the SDK at all. The seam is a plain function, so this file
 * stays testable with no credentials and no vendor.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { unavailable, type AppConfig, type Capabilities } from '../config.ts';
import { childLogger } from '../logging.ts';
import { CLIENT_IDENTITY, VOICE_TOKEN_PATH } from '../../shared/handoff.ts';
import type { App } from './types.ts';

const log = childLogger('handoff-http');

/** Injected from `server/index.ts`. Returns a signed JWT; never makes a network call. */
export type MintToken = (identity: string) => string;

export interface HandoffRoutes {
  /**
   * Called once, after TAC boots. Late injection rather than a constructor argument because
   * `buildApp()` runs BEFORE any Twilio credential has been proven usable — `TAC.create()` performs a
   * network call that can fail — and the route must answer 503 in the meantime rather than 404.
   */
  setMintToken(mint: MintToken): void;
}

export function registerHandoffRoutes(
  app: App,
  deps: {
    readonly config: AppConfig;
    readonly caps: Capabilities;
    /** Only tests pass this at construction; production injects via `setMintToken`. */
    readonly mintToken?: MintToken;
  },
): HandoffRoutes {
  let mintToken: MintToken | undefined = deps.mintToken;

  app.post(VOICE_TOKEN_PATH, (request, reply) => {
    /**
     * `caps.voice` rather than `caps.handoff`, deliberately. The softphone must be able to register
     * BEFORE a Studio flow exists — that is the whole point of the direct-`<Dial>` path, and rung 4 of
     * the verification ladder registers a client with no flow configured at all.
     */
    if (!deps.caps.voice || mintToken === undefined) {
      // Names the missing variable. A softphone handed `{token: undefined}` fails inside the SDK with a
      // message about the token, which sends the reader to the wrong file entirely.
      log.warn(
        { hasVoiceCapability: deps.caps.voice, hasMinter: mintToken !== undefined },
        'voice token requested on a process that cannot mint one',
      );
      void reply.code(503).send(unavailable(deps.config, 'voice'));
      return;
    }

    // No request body is read. The identity is OURS, not the caller's: letting a client choose its own
    // identity would let any browser register as the agent.
    void reply.code(200).send({
      token: mintToken(CLIENT_IDENTITY),
      identity: CLIENT_IDENTITY,
      ttlSeconds: 3600,
    });
  });

  return {
    setMintToken: (mint) => {
      mintToken = mint;
    },
  };
}
```

⚠ `ttlSeconds: 3600` duplicates `VOICE_TOKEN_TTL_SECONDS`, which this file may not import (it lives
beside the `twilio` import). Task 6 removes the duplication by moving the constant to
`shared/handoff.ts`; if you are implementing Task 5 alone, move it now rather than leaving two numbers.

- [ ] **Step 6: Register and inject**

In `server/http/app.ts`:

```ts
import { registerHandoffRoutes, type HandoffRoutes } from './routes-handoff.ts';

// widen the return type:
export function buildApp(deps: AppDeps): { app: App; obs: ObsRoutes; bench: BenchRoutes; handoff: HandoffRoutes } {

  // ...beside the other registrations:
  const handoff = registerHandoffRoutes(app, { config, caps });

  return { app, obs, bench, handoff };
}
```

In `server/index.ts`, wherever `bootTac` is awaited successfully, inject the minter. It belongs on the
success path only — a failed boot must leave the route answering 503:

```ts
  // Dynamic, exactly like the `bootTac` import above it and for the same reason: a process with no
  // Twilio credentials must never load the `twilio` SDK.
  const { mintVoiceToken } = await import('./twilio/voice-token.ts');
  handoff.setMintToken((identity) =>
    mintVoiceToken({
      accountSid: twilioConfig.accountSid,
      apiKey: twilioConfig.apiKey,
      apiSecret: twilioConfig.apiSecret,
      identity,
    }),
  );
```

Use whatever local name `server/index.ts` already has for the non-null `config.twilio`; if it has none,
narrow it once with `const twilioConfig = config.twilio; if (twilioConfig === null) return;` beside the
existing capability gate rather than repeating `config.twilio?.` three times.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, ~317 tests. The architecture test is the one to watch — it fails loudly if `twilio`
ended up imported outside `server/twilio/`.

- [ ] **Step 8: Prove it on the real process (free)**

```bash
curl -s -X POST http://localhost:8910/api/voice/token | head -c 200
```

Expected: JSON with `identity: "browser_agent"` and a three-part JWT. Decode the claims to confirm
`grants.voice.incoming.allow === true` and that `grants.voice.outgoing` is absent:

```bash
curl -s -X POST http://localhost:8910/api/voice/token \
  | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['token'].split('.')[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(t+'==')),indent=2))"
```

- [ ] **Step 9: Commit**

```bash
git add server/twilio/voice-token.ts server/http/routes-handoff.ts server/http/app.ts \
        server/index.ts tests/handoff-http.test.ts package.json pnpm-lock.yaml
git commit -m "T14b.5: mint the Voice SDK token — injected, so server/http never imports twilio"
```

---

### Task 6: The screen pop route

**Files:**
- Modify: `server/http/routes-handoff.ts`, `shared/handoff.ts` (move the TTL constant)
- Test: `tests/handoff-http.test.ts`

**Interfaces:**
- Consumes: `findHandoffSnapshot` (Task 2), `HandoffContextResponse`, `HANDOFF_CONTEXT_PATH` (Task 1).
- Produces: `GET /api/handoff/context?conversationId=&from=` → `HandoffContextResponse`. `VOICE_TOKEN_TTL_SECONDS` moves to `shared/handoff.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/handoff-http.test.ts`:

```ts
import { recordHandoffSnapshot, forgetHandoffSnapshot } from '../server/handoff/snapshots.ts';
import { HANDOFF_CONTEXT_PATH } from '../shared/handoff.ts';

const withContextApp = async (fn: (app: App) => Promise<void>): Promise<void> => {
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  registerHandoffRoutes(app, { config, caps: capabilities(config) });
  await fn(app);
  await app.close();
};

test('the screen pop returns the reason, the transcript and a MASKED number', async () => {
  recordHandoffSnapshot({
    conversationId: 'conv_pop_1',
    reason: 'caller asked for a person',
    from: '+15557778888',
    at: '2026-09-14T10:00:00.000Z',
    transcript: [
      { role: 'user', text: 'I want a human' },
      { role: 'assistant', text: 'Putting you through.' },
    ],
  });

  await withContextApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: `${HANDOFF_CONTEXT_PATH}?conversationId=conv_pop_1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ found: true, match: 'exact', reason: 'caller asked for a person' });
    // The transcript is VERBATIM by necessity — the human needs the real words. The NUMBER is not.
    expect(body.transcript).toHaveLength(2);
    expect(body.transcript[0]).toEqual({ role: 'user', text: 'I want a human' });
    expect(body.maskedFrom).not.toBe('+15557778888');
    expect(body.maskedFrom).toContain('8888');
    expect(JSON.stringify(body)).not.toContain('+15557778888');
  });

  forgetHandoffSnapshot('conv_pop_1');
});

test('a caller-number lookup works, which is the Studio path', async () => {
  recordHandoffSnapshot({
    conversationId: 'conv_pop_2',
    reason: 'upset caller',
    from: '+15551112222',
    at: '2026-09-14T10:00:00.000Z',
    transcript: [],
  });

  await withContextApp(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: `${HANDOFF_CONTEXT_PATH}?from=${encodeURIComponent('+15551112222')}`,
    });
    expect(res.json()).toMatchObject({ found: true, match: 'caller', reason: 'upset caller' });
  });

  forgetHandoffSnapshot('conv_pop_2');
});

test('an empty store answers 200 with found:false — never a 404', async () => {
  // The page renders this state. A 404 would land in the browser console as a failed fetch instead.
  await withContextApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: HANDOFF_CONTEXT_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: false, match: 'none', reason: null, transcript: [] });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test -- tests/handoff-http.test.ts`
Expected: FAIL — the route 404s, so `res.statusCode` is 404.

- [ ] **Step 3: Move the TTL constant into `shared/handoff.ts`**

Append to `shared/handoff.ts`:

```ts
/**
 * AccessToken lifetime. One hour, which is Twilio's own default.
 *
 * Lives in `shared/` because both sides need it and neither may import the other's: the minter is in
 * `server/twilio/` (it imports the `twilio` package) and the route that reports it is in `server/http/`
 * (which may not). Two hard-coded 3600s would drift the moment one was tuned.
 */
export const VOICE_TOKEN_TTL_SECONDS = 3600;
```

Then in `server/twilio/voice-token.ts` import it instead of declaring it, and in
`server/http/routes-handoff.ts` replace the literal `3600` with the import.

- [ ] **Step 4: Add the context route**

In `server/http/routes-handoff.ts`, add the imports and the route:

```ts
import { findHandoffSnapshot } from '../handoff/snapshots.ts';
import { maskPhone } from '../obs/pii.ts';
import {
  CLIENT_IDENTITY,
  HANDOFF_CONTEXT_PATH,
  VOICE_TOKEN_PATH,
  VOICE_TOKEN_TTL_SECONDS,
  type HandoffContextResponse,
} from '../../shared/handoff.ts';

  /**
   * The screen pop. NO CAPABILITY GATE and NO 404 — it always answers 200 with a body the page can
   * render, because `found: false` is a state the UI shows ("no context for this call") rather than an
   * error it has to handle. A 404 here would surface in the browser as a failed fetch and send the
   * reader looking for a routing bug.
   *
   * DELIBERATELY NOT a live memory or profile lookup. Conversation Orchestrator extracts observations
   * only AFTER a conversation ends, so for a first-time caller a memory panel would be empty at exactly
   * the moment it is being demoed. What this returns is what the agent just heard, which is always
   * present and always relevant.
   */
  app.get(HANDOFF_CONTEXT_PATH, (request, reply) => {
    const query = request.query as { conversationId?: string; from?: string };
    const { snapshot, match } = findHandoffSnapshot({
      conversationId: query.conversationId ?? null,
      from: query.from ?? null,
    });

    const body: HandoffContextResponse =
      snapshot === null
        ? { found: false, match: 'none', reason: null, conversationId: null, maskedFrom: null, at: null, transcript: [] }
        : {
            found: true,
            match,
            reason: snapshot.reason,
            conversationId: snapshot.conversationId,
            /**
             * MASKED. `../obs/pii.ts` scrubs log lines and obs payloads and does NOT scrub this
             * route's body — so masking has to be explicit, here, at the boundary. The transcript
             * below is verbatim on purpose: the human agent needs the real words, and the design doc
             * §10 states that as a new PII surface rather than hiding it.
             */
            maskedFrom: snapshot.from === null ? null : maskPhone(snapshot.from),
            at: snapshot.at,
            transcript: snapshot.transcript,
          };

    void reply.code(200).send(body);
  });
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, ~320 tests.

- [ ] **Step 6: Prove it against a synthetic snapshot (free)**

There is no snapshot on a fresh process, so this proves the empty shape — which is the one the page
renders first:

```bash
curl -s "http://localhost:8910/api/handoff/context" | python3 -m json.tool
```

Expected: `{"found": false, "match": "none", ..., "transcript": []}` with a 200.

- [ ] **Step 7: Commit**

```bash
git add shared/handoff.ts server/twilio/voice-token.ts server/http/routes-handoff.ts \
        tests/handoff-http.test.ts
git commit -m "T14b.6: the screen pop — verbatim transcript, masked number, never a 404"
```

---

### Task 7: The browser softphone

Rung 4 of the ladder, and the schedule risk the design doc flagged: **the transfer cannot be
demonstrated at all until a client is registered**, so this lands before the frame work is verified
end-to-end.

**Files:**
- Create: `web/src/app/softphone/page.tsx`, `web/src/app/softphone/softphone-client.tsx`
- Modify: `web/package.json` (via `pnpm add`)
- Test: manual — driven in a browser. No vitest file; `web/` has no test runner and adding one is out of scope.

**Interfaces:**
- Consumes: `CLIENT_IDENTITY`, `VOICE_TOKEN_PATH`, `HANDOFF_CONTEXT_PATH`, `HandoffContextResponse` from `shared/handoff.ts`.
- Produces: a page at `/softphone`.

- [ ] **Step 1: Read the existing client-island pattern first**

Run: `cat web/src/app/bench/bench-chat.tsx`

Copy its conventions rather than inventing new ones — specifically how it fetches a relative path (the
Next dev rewrite proxies `/api/*` to the agent, so the browser must never name an origin), how it holds
state, and which Strix components it imports. **Do not invent Strix component APIs**; use the ones that
file already uses, plus plain elements with Tailwind classes for anything else.

- [ ] **Step 2: Add the SDK, pinned to a version at least 7 days old**

```bash
# Find the newest version that is at least 7 days old, then install exactly that.
npm view @twilio/voice-sdk time --json | python3 -c "
import sys, json, datetime
t = json.load(sys.stdin)
cutoff = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=7)
ok = [(v, d) for v, d in t.items() if v[0].isdigit() and datetime.datetime.fromisoformat(d) < cutoff]
ok.sort(key=lambda vd: vd[1])
print(ok[-1])
"
pnpm --dir web add @twilio/voice-sdk@<that version>
```

⚠ Pinned **by hand** because the repo's 7-day supply-chain guard is not actually enforced: pnpm 11.8
does not read `minimum-release-age` from `.npmrc`, and `pnpm-workspace.yaml` has no `minimumReleaseAge`.
Reported, not policed — but this is a browser-executed dependency, so the pin is worth the minute.

- [ ] **Step 3: Write the server component**

Create `web/src/app/softphone/page.tsx`:

```tsx
/**
 * `/softphone` — where a human answers a transferred call.
 *
 * A SERVER component wrapping one client island, the shape spike S2 verified and `/bench` already
 * uses: Strix renders from the server, and only the part that needs state, a fetch and a WebRTC device
 * carries `'use client'`.
 *
 * This page is the reason the transfer is demonstrable at all — until a client is registered as
 * `browser_agent` there is nothing for the flow to dial.
 */
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { SoftphoneClient } from './softphone-client.tsx';

export default function SoftphonePage() {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-8" data-testid="softphone">
      {/* `as` rather than a render prop — an element crossing the server→client boundary that way
          arrives without props and blanks the page after hydration (the S2 gotcha). */}
      <Typography variant="h3" as="h1">
        Softphone
      </Typography>
      <Typography variant="body-s" as="p" className="text-text-secondary">
        Register, then wait. When the agent transfers a caller, this rings and shows why they were
        transferred plus what was already said.
      </Typography>

      <Separator />

      <SoftphoneClient />
    </main>
  );
}
```

- [ ] **Step 4: Write the client island**

Create `web/src/app/softphone/softphone-client.tsx`:

```tsx
'use client';

/**
 * The softphone itself: register, ring, screen-pop, answer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `@twilio/voice-sdk` IS IMPORTED DYNAMICALLY, AND THAT IS NOT AN OPTIMISATION.
 *
 * The module emits a `console.warn` at LOAD time in a non-browser context, so a static top-level
 * import would fire on every server-side render pass of this route — noise in the server log that
 * looks like an application warning. It also touches browser globals. `await import()` inside an
 * effect keeps it strictly client-side.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EVERY FETCH USES A RELATIVE PATH. In production Traefik splits one public host by path; in
 * development `web/next.config.ts` rewrites `/api/*` to the agent on :8910. Naming an origin here
 * would need CORS (a JSON POST is preflighted, so it fails on the OPTIONS) and would then have to be
 * stripped for production.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLIENT_IDENTITY,
  HANDOFF_CONTEXT_PATH,
  VOICE_TOKEN_PATH,
  type HandoffContextResponse,
} from '../../../../shared/handoff.ts';

type Status = 'idle' | 'registering' | 'registered' | 'ringing' | 'on-call' | 'error';

/** Just the members this file touches, so the vendor's types never reach the component signature. */
interface IncomingCall {
  readonly parameters: Record<string, string>;
  customParameters: Map<string, string>;
  accept(): void;
  disconnect(): void;
  on(event: string, handler: () => void): void;
}

export function SoftphoneClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<HandoffContextResponse | null>(null);
  const [callerNumber, setCallerNumber] = useState<string | null>(null);
  const deviceRef = useRef<{ register(): Promise<void>; destroy(): void; updateToken(t: string): void; on(e: string, h: (a?: unknown) => void): void } | null>(null);
  const callRef = useRef<IncomingCall | null>(null);

  const fetchToken = useCallback(async (): Promise<string> => {
    const res = await fetch(VOICE_TOKEN_PATH, { method: 'POST' });
    if (!res.ok) {
      // The route 503s NAMING the missing variable, so surfacing the body is what makes a
      // half-configured process diagnosable from the page instead of from the server log.
      const body = (await res.json().catch(() => ({}))) as { missing?: { name: string }[] };
      const names = (body.missing ?? []).map((m) => m.name).join(', ');
      throw new Error(names === '' ? `token request failed (${res.status})` : `not configured: ${names}`);
    }
    return ((await res.json()) as { token: string }).token;
  }, []);

  /**
   * The screen pop. Tried by `conversationId` first — the direct-`<Dial>` path carries it as a
   * `<Parameter>`, which the SDK surfaces as `call.customParameters` — then by the caller's number,
   * which is all the Studio path can offer because its `connect-call-to` widget cannot pass parameters
   * to a client and dialling a client mints a new CallSid.
   */
  const loadContext = useCallback(async (conversationId: string | null, from: string | null) => {
    const params = new URLSearchParams();
    if (conversationId !== null) params.set('conversationId', conversationId);
    if (from !== null) params.set('from', from);
    const res = await fetch(`${HANDOFF_CONTEXT_PATH}?${params.toString()}`);
    // Always 200 with a renderable body, so there is no error branch to write here.
    setContext((await res.json()) as HandoffContextResponse);
  }, []);

  const register = useCallback(async () => {
    setStatus('registering');
    setError(null);
    try {
      const { Device } = await import('@twilio/voice-sdk');
      const token = await fetchToken();

      /**
       * NO `tokenRefreshMs` / `refreshTokenMs` OPTION SET, deliberately: Twilio's own documentation
       * spells that option BOTH ways in different places, so relying on either name risks silently
       * setting nothing. The default already fires `tokenWillExpire` 10 s before expiry, which is what
       * the handler below needs. If a longer warning is ever wanted, verify the spelling against the
       * installed `.d.ts` first rather than against the docs.
       */
      const device = new Device(token) as unknown as NonNullable<typeof deviceRef.current>;
      deviceRef.current = device;

      device.on('registered', () => setStatus('registered'));
      device.on('unregistered', () => setStatus('idle'));
      device.on('error', (err) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

      // A token that quietly expires takes the softphone offline with nothing on screen to say why.
      device.on('tokenWillExpire', () => {
        void fetchToken().then((fresh) => device.updateToken(fresh));
      });

      device.on('incoming', (incoming) => {
        const call = incoming as IncomingCall;
        callRef.current = call;
        setStatus('ringing');
        const from = call.parameters.From ?? null;
        setCallerNumber(from);
        void loadContext(call.customParameters.get('conversationId') ?? null, from);

        // Both endings, or a cancelled call leaves the UI ringing forever.
        call.on('disconnect', () => {
          callRef.current = null;
          setStatus('registered');
        });
        call.on('cancel', () => {
          callRef.current = null;
          setStatus('registered');
        });
      });

      await device.register();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchToken, loadContext]);

  // One identity allows 10 concurrent registrations and the 11th EVICTS THE OLDEST, so a page that
  // leaked a Device on every hot reload would silently steal its own registration.
  useEffect(() => () => deviceRef.current?.destroy(), []);

  const answer = (): void => {
    callRef.current?.accept();
    setStatus('on-call');
  };
  const hangUp = (): void => callRef.current?.disconnect();

  return (
    <section className="flex flex-col gap-4" data-testid="softphone-client">
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-secondary">
          {CLIENT_IDENTITY} — {status}
        </span>
        {status === 'idle' || status === 'error' ? (
          <button type="button" onClick={() => void register()} className="rounded border px-3 py-1 text-sm">
            Register
          </button>
        ) : null}
      </div>

      {error === null ? null : (
        <p className="text-sm text-red-600" data-testid="softphone-error">
          {error}
        </p>
      )}

      {status === 'ringing' || status === 'on-call' ? (
        <div className="flex flex-col gap-3 rounded border p-4" data-testid="screen-pop">
          <p className="text-sm">
            Incoming call{callerNumber === null ? '' : ` from ${callerNumber}`}
          </p>
          {context?.found === true ? (
            <>
              <p className="text-sm font-medium">Why: {context.reason}</p>
              {/* The match quality is SHOWN, not hidden: `recent` can be the wrong call under load, and
                  a human reading a transcript needs to know how confident the correlation was. */}
              <p className="text-xs text-text-secondary">
                matched on {context.match}
                {context.maskedFrom === null ? '' : ` — ${context.maskedFrom}`}
              </p>
              <ol className="flex flex-col gap-1 text-sm">
                {context.transcript.map((turn, i) => (
                  <li key={i}>
                    <strong>{turn.role === 'user' ? 'Caller' : 'Agent'}:</strong> {turn.text}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm text-text-secondary">No context for this call.</p>
          )}
          <div className="flex gap-2">
            {status === 'ringing' ? (
              <button type="button" onClick={answer} className="rounded border px-3 py-1 text-sm">
                Answer
              </button>
            ) : null}
            <button type="button" onClick={hangUp} className="rounded border px-3 py-1 text-sm">
              Hang up
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
```

⚠ Check the relative import depth for `shared/handoff.ts` against how `bench-chat.tsx` imports from
`shared/` — `web/tsconfig.json` may define a path alias, in which case use that instead of `../../../../`.

- [ ] **Step 5: Typecheck both projects**

Run: `pnpm typecheck`
Expected: PASS. This runs `tsc --noEmit` for the server and then `pnpm --dir web exec tsc --noEmit`.

⚠ If the SDK's `Device` type conflicts with the narrow local interfaces, do NOT widen the interfaces to
the vendor's types — that would put a browser vendor type on a component signature. Cast at the
`await import()` boundary, which is what the `as unknown as` above is for.

- [ ] **Step 6: Register a client with no call placed — rung 4, and it costs nothing**

```bash
pnpm dev:all    # agent on :8910, Next on :3000
```

Open <http://localhost:3000/softphone> and press **Register**. Expected on screen:
`browser_agent — registered`.

This one screen proves four things at once: the token route works, the grant permits *receiving*, no
TwiML Application was needed, and — the open question from the design doc §3.1 — that the
**hyphen-free identity is accepted**. If it says `error`, read the message on the page: a `not
configured:` prefix means an env var, anything else is the SDK.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/softphone web/package.json pnpm-lock.yaml
git commit -m "T14b.7: the browser softphone — registers as browser_agent, screen-pops on ring"
```

---

### Task 8: Teach the voice prompt when to transfer

The tool description is the floor; the prompt is where the policy lives, because it is
Langfuse-versioned and therefore tunable in front of a customer with no redeploy.

**Files:**
- Modify: `server/agent/prompt/defaults.ts` (`VOICE_SYSTEM`, and the voice `config.tools`)
- Test: `tests/tools.test.ts` (existing assertions cover it), `tests/prompt.test.ts` (may assert the tool list)

**Interfaces:**
- Consumes: `TAC_TOOL_NAMES` containing `handoff` (Task 1).
- Produces: `DEFAULT_PROMPTS['demo-agent-voice'].config.tools` includes `'handoff'`.

- [ ] **Step 1: Name the tool in the voice prompt only**

In `server/agent/prompt/defaults.ts`, change the voice `tools` array (line 164) and extend the comment
above it:

```ts
      // `end_call` and `handoff` are both voice-only — one hangs up, the other transfers — and the text
      // prompt must not name either. Note each costs a step: the model calls the tool and then speaks
      // one line, so a closing or transferring turn uses two of the three below.
      //
      // `handoff` is voice-only for a REASON, not by omission. TAC's tool branches internally and its
      // digital branch works, but it sets the conversation INACTIVE and clears its status callbacks
      // BEFORE the POST that can fail, and TAC has no `'ACTIVE'` write and no inverse for
      // `clearStatusCallbacks` anywhere. On SMS a failed handoff therefore leaves a customer whose next
      // text reaches nothing. Sending the frame (`server/twilio/voice.ts`) is what mitigates that
      // failure path on voice; nothing mitigates it on SMS. Naming it in the text prompt is a one-line
      // change once a text-transfer destination exists and that failure path has been re-verified.
      //
      // `retrieve_profile_memory` is deliberately NOT here, though it resolves on this channel.
      // Memory already arrives in the system prompt every turn — `memoryMode: 'once'` recalls it and
      // `server/twilio/memory-compose.ts` folds it in — so on voice the tool could only re-fetch what
      // the model can already read, at the price of a step, and a step on this channel is silence.
      // The text prompt names it, where the trade is different.
      tools: ['lookup_order', 'get_store_hours', 'search_knowledge', 'end_call', 'handoff'],
```

- [ ] **Step 2: Add the transfer guidance to `VOICE_SYSTEM`**

Insert this section immediately before `How to end the call` in `VOICE_SYSTEM`:

```
How to hand off to a person
- Use handoff when the caller asks to speak to a person, or when they are upset enough that a
  person should take over. Then say one short line telling them you are putting them through, and
  nothing else.
- Do not use handoff because a question is hard. Look it up first: policy questions are answered by
  search_knowledge, order questions by lookup_order. Transferring instead of looking something up
  is the one thing that makes this worse than a search.
- Do not offer a transfer unprompted just because you could not answer something. Say what you do
  not know, offer to have someone follow up, and let the caller ask for a person if they want one.
- handoff is not how you end a finished call — that is end_call. Never call both.
```

⚠ Keep it in the same voice as the rest of the file: imperative bullets, no markdown that a TTS engine
would read aloud, and it must read correctly on a prompt version where `search_knowledge` is not
offered (the same constraint `SEARCH_KNOWLEDGE_DESCRIPTION` documents).

- [ ] **Step 3: Run the suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Three existing tests exercise this without modification — the `buildable` set check, the
preflight-reports-no-problem test (whose debug line now mentions `handoff`, which is why Task 1 Step 5
made that assertion derive from the defaults), and whatever `tests/prompt.test.ts` asserts about the
compiled config. If a prompt test pins the exact tool array, update it to the new five.

- [ ] **Step 4: Confirm the boot preflight stays quiet**

Run: `pnpm dev` and read the first lines of the log.
Expected: **no ERROR** about an unknown prompt tool, and one `debug`-level line naming the TAC-provided
tools the defaults reference. An ERROR here means `handoff` is missing from `TAC_TOOL_NAMES` — i.e. Task
1 was skipped — and the symptom in production would be one warning per turn and an agent that quietly
cannot transfer.

Also confirm the augmented catalog contains it, in the `tac: listening` line:

```bash
curl -s http://localhost:8910/health | python3 -m json.tool | grep -A3 capabilities
```

Expected: `"handoff": true` when `TWILIO_STUDIO_HANDOFF_FLOW_SID` is set in `.env`, `false` when not.

- [ ] **Step 5: Push the prompt to Langfuse**

```bash
pnpm seed:prompts demo-agent-voice
```

⚠ **Name the prompt.** A bare `pnpm seed:prompts` re-seeds BOTH and moves the `production` label onto a
new version of `demo-agent-text` as well — which silently discards any edit an operator made to it in
the Langfuse UI. Nothing is destroyed (versions are immutable, the label can be moved back), but the
whole point of the prompt investment is that operator edits are real.

Expected: `demo-agent-voice: created v<N> [production]`.

- [ ] **Step 6: Commit**

```bash
git add server/agent/prompt/defaults.ts tests/
git commit -m "T14b.8: teach the voice prompt to transfer — and not to transfer instead of searching"
```

---

### Task 9: The Studio flow, as a committed definition plus a seed script

**Files:**
- Create: `scripts/studio-handoff-flow.ts` (the definition), `scripts/seed-studio-flow.ts` (the publisher)
- Modify: `package.json` (a `seed:studio` script)
- Test: none — `scripts/` has no test runner. Verification is the run itself plus the backup diff.

**Interfaces:**
- Consumes: `CLIENT_IDENTITY` from `shared/handoff.ts`; `loadConfig` from `server/config.ts`.
- Produces: `STUDIO_HANDOFF_FLOW_DEFINITION`, `STUDIO_FLOW_FRIENDLY_NAME`; `pnpm seed:studio`.

**The definition, confirmed against Twilio's Studio Flow Definition schema:** the envelope is
`{ description, states, initial_state: 'Trigger', flags: { allow_concurrent_calls: true } }`; the trigger
state is `type: 'trigger'`, `name: 'Trigger'`, with transitions keyed on `incomingCall` /
`incomingMessage` / `incomingRequest`; `connect-call-to` takes `properties: { noun, to, caller_id,
timeout, offset }` with `noun` in `['client','conference','number','number-multi','sim','sip']` and
required, and transitions `callCompleted` / `hangup`.

- [ ] **Step 1: Write the definition**

Create `scripts/studio-handoff-flow.ts`:

```ts
/**
 * The Studio flow that answers a transferred call, as data in the repo.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS TWO WIDGETS, AND IT RECEIVES NO HANDOFF DATA.
 *
 * The design doc (§8) specified a `set-variables` widget reading `{{trigger.call.HandoffData}}` typed
 * `json_object`, and called that type the load-bearing detail. That is correct when STUDIO ITSELF is
 * the `<Connect action>` URL — ConversationRelay posts `HandoffData` in the body and Studio surfaces it
 * on the trigger. But this repo must own the action route (TAC's own route strips `HandoffData` and
 * answers text/plain), so Studio is reached by a `<Redirect>`, which starts a FRESH incoming-call
 * execution. Twilio documents the Incoming Call trigger's variables as a FIXED set — the Call resource
 * fields — so a custom query parameter would silently resolve to nothing.
 *
 * The flow therefore does not need it. Everything the human agent sees comes from
 * `GET /api/handoff/context`, correlated on the caller's number, which is the mechanism the design
 * already required anyway: the `connect-call-to` widget cannot pass parameters to a client, and dialling
 * a client mints a new call leg with a new CallSid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A COMMITTED DEFINITION AT ALL, rather than clicking it in the Console: the same reason
 * `scripts/knowledge-articles.ts` exists. A flow that lives only in one Twilio account cannot be handed
 * to anybody, and this repo is cloned per demo. The Console remains the place to EDIT it; this is the
 * place it comes from.
 */
import { CLIENT_IDENTITY } from '../shared/handoff.ts';

export const STUDIO_FLOW_FRIENDLY_NAME = 'demo-scaffold-human-handoff';

/**
 * `caller_id: {{contact.channel.address}}` is the load-bearing line.
 *
 * It preserves the ORIGINAL caller's number on the leg dialled to the browser, which is the only
 * correlator the screen pop has on this path. Replace it with a Twilio number and the pop degrades from
 * a `caller` match to a `recent` one — still functional, but wrong under any concurrency.
 *
 * `noun: 'client'` with `to: CLIENT_IDENTITY` is the Voice SDK identity form. The identity is imported
 * rather than written out because the token route, this flow and the page must agree, and it must
 * contain NO HYPHEN — the Voice SDK documents the identity charset as alphanumerics and underscores,
 * and the flow previously published on this account dialled `client:browser-agent`, which is outside it.
 *
 * `timeout: 30` bounds the ring. Both transitions are terminal (`next: null`): there is no voicemail
 * fallback and no second attempt, which the design doc lists under deliberate omissions.
 */
export const STUDIO_HANDOFF_FLOW_DEFINITION = {
  description: 'Demo scaffold: answer a call handed off by the AI agent by dialling the browser softphone.',
  states: [
    {
      name: 'Trigger',
      type: 'trigger',
      properties: { offset: { x: 0, y: 0 } },
      transitions: [
        // Only the voice trigger is wired. The other two are declared with no `next` because the schema
        // expects the trigger's transition list, and leaving them unrouted is how "this flow is
        // voice-only" is expressed in data.
        { event: 'incomingCall', next: 'connect_to_softphone' },
        { event: 'incomingMessage' },
        { event: 'incomingRequest' },
        { event: 'incomingParent' },
      ],
    },
    {
      name: 'connect_to_softphone',
      type: 'connect-call-to',
      properties: {
        noun: 'client',
        to: CLIENT_IDENTITY,
        caller_id: '{{contact.channel.address}}',
        timeout: 30,
        offset: { x: 200, y: 240 },
      },
      transitions: [{ event: 'callCompleted' }, { event: 'hangup' }],
    },
  ],
  initial_state: 'Trigger',
  flags: { allow_concurrent_calls: true },
} as const;
```

⚠ If the PUT is rejected with a schema validation error, the fastest fix is to build the flow once in the
Console editor, then `GET /v2/Flows/{sid}` and diff its `definition` against this object. Do that rather
than guessing at property names — the schema is versioned and the error messages name the offending path.

- [ ] **Step 2: Write the seed script**

Create `scripts/seed-studio-flow.ts`, following `scripts/repoint-public-host.ts`'s backup discipline
exactly — **GET, write to disk, RE-READ and validate, only then PUT**:

```ts
/**
 * Publish the committed handoff flow over the Studio flow named by `TWILIO_STUDIO_HANDOFF_FLOW_SID`.
 *
 *   pnpm seed:studio            # dry run: fetch, back up, print the diff, change nothing
 *   pnpm seed:studio --write    # publish
 *
 * Companion to `pnpm seed:prompts` and `pnpm seed:knowledge`: the repo owns the content, the account
 * owns the live resource.
 *
 * ── THE BACKUP IS NOT OPTIONAL, AND IT IS RE-READ ───────────────────────────────────────────────
 *
 * A flow update is a FULL REPLACE of `Definition`. So this GETs the current flow, writes it verbatim to
 * `.superpowers/t14b/`, re-reads that file and checks it parses and still carries a `definition` with a
 * `states` array, and only then PUTs. A truncated backup is worse than none, because it reads as
 * recoverable right up until it is needed — which is why the re-read exists rather than trusting the
 * write. Recovery is PUTting the saved `definition` back unchanged.
 *
 * Twilio also retains the prior REVISION server-side (`GET /v2/Flows/{sid}/Revisions`), so there are two
 * independent ways back. The local copy is the one that survives losing account access.
 *
 * DRY RUN BY DEFAULT. `--write` is the same gate `repoint-public-host.ts` uses, for the same reason:
 * this mutates a live account resource, and the default behaviour of a script somebody is running for
 * the first time should be to show them what it would do.
 *
 * `scripts/` is exempt from the no-console rule and from the vendor boundary. It is not exempt from
 * exiting non-zero when it fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { CLIENT_IDENTITY } from '../shared/handoff.ts';
import { STUDIO_FLOW_FRIENDLY_NAME, STUDIO_HANDOFF_FLOW_DEFINITION } from './studio-handoff-flow.ts';

const STUDIO_BASE = 'https://studio.twilio.com/v2';
const BACKUP_DIR = '.superpowers/t14b';

const app = loadConfig(process.env);
if (app.twilio === null) {
  console.error('seed:studio needs Twilio credentials. Missing or malformed:');
  for (const m of app.missing.filter((v) => v.feature === 'Twilio')) {
    console.error(`  ${m.name} — ${m.breaks}`);
  }
  process.exit(1);
}
if (app.studioHandoffFlowSid === null) {
  // Deliberately does NOT create a flow. Creating one would hand back a SID that has to be pasted into
  // `.env` anyway, and this script's whole value is that the flow it publishes is reviewable in git —
  // which a freshly created empty flow is not. Point it at a flow that exists.
  console.error(
    'seed:studio needs TWILIO_STUDIO_HANDOFF_FLOW_SID (FW + 32 LOWERCASE hex chars) in .env.\n' +
      'Create an empty flow in the Studio console, paste its SID, then re-run.',
  );
  process.exit(1);
}

const write = process.argv.includes('--write');
const flowSid = app.studioHandoffFlowSid;
const auth = `Basic ${Buffer.from(`${app.twilio.apiKey}:${app.twilio.apiSecret}`).toString('base64')}`;

interface Res {
  readonly status: number;
  readonly body: unknown;
}

const call = async (method: string, path: string, form?: URLSearchParams): Promise<Res> => {
  const res = await fetch(`${STUDIO_BASE}${path}`, {
    method,
    headers: {
      authorization: auth,
      ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(form === undefined ? {} : { body: form.toString() }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

/** Annotated on the VARIABLE so TypeScript treats a call as terminating and narrows afterwards. */
const die: (msg: string, res?: Res) => never = (msg, res) => {
  console.error(`\nFAILED: ${msg}`);
  if (res !== undefined) console.error(`  HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 800)}`);
  process.exit(1);
};

// ---- 1. fetch the live flow ----

const current = await call('GET', `/Flows/${flowSid}`);
if (current.status !== 200) die(`could not read flow ${flowSid}`, current);
const live = current.body as { friendly_name?: string; status?: string; revision?: number; definition?: { states?: unknown[] } };
console.log(`live: ${live.friendly_name ?? '?'} status=${live.status ?? '?'} revision=${live.revision ?? '?'}`);
console.log(`      ${live.definition?.states?.length ?? 0} state(s)`);

// ---- 2. back it up, then RE-READ it ----

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/flow-${flowSid}-revision-${live.revision ?? 'unknown'}.json`;
writeFileSync(backupPath, JSON.stringify(current.body, null, 2));

const reread = JSON.parse(readFileSync(backupPath, 'utf8')) as typeof live;
if (!Array.isArray(reread.definition?.states)) {
  die(`the backup at ${backupPath} does not carry definition.states — refusing to publish over the live flow`);
}
console.log(`backup: ${backupPath} (re-read, ${reread.definition.states.length} state(s))`);

// ---- 3. show what changes ----

const nextStates = STUDIO_HANDOFF_FLOW_DEFINITION.states.map((s) => `${s.name} (${s.type})`);
console.log(`\nwould publish ${nextStates.length} state(s): ${nextStates.join(', ')}`);
console.log(`  dialling client:${CLIENT_IDENTITY} — note NO HYPHEN, which is the Voice SDK identity rule`);

if (!write) {
  console.log('\nDRY RUN. Nothing was changed. Re-run with --write to publish.');
  process.exit(0);
}

// ---- 4. publish ----

const form = new URLSearchParams();
form.append('FriendlyName', STUDIO_FLOW_FRIENDLY_NAME);
// `published`, not `draft`: a draft flow is not reachable by the webhook URL our action route redirects
// to, so publishing a draft would look exactly like a broken redirect.
form.append('Status', 'published');
form.append('Definition', JSON.stringify(STUDIO_HANDOFF_FLOW_DEFINITION));
form.append('CommitMessage', 'demo-scaffold T14b: dial the browser softphone');

const put = await call('POST', `/Flows/${flowSid}`, form);
if (put.status !== 200) die('the flow update was rejected', put);
const updated = put.body as { revision?: number; status?: string };
console.log(`\npublished: revision ${updated.revision ?? '?'} status=${updated.status ?? '?'}`);

// ---- 5. re-read and confirm what landed ----

const after = await call('GET', `/Flows/${flowSid}`);
if (after.status !== 200) die('could not re-read the flow after publishing', after);
const landed = (after.body as { definition?: { states?: { name?: string; properties?: { to?: string } }[] } }).definition;
const connect = landed?.states?.find((s) => s.name === 'connect_to_softphone');
if (connect?.properties?.to !== CLIENT_IDENTITY) {
  die(`the published flow dials ${String(connect?.properties?.to)} rather than ${CLIENT_IDENTITY}`);
}
console.log(`confirmed: connect_to_softphone dials client:${CLIENT_IDENTITY}`);
console.log(`\nrecovery: PUT the "definition" from ${backupPath} back, or restore the prior revision.`);
```

- [ ] **Step 3: Add the script entry**

```bash
pnpm pkg set scripts.seed:studio="node --env-file-if-exists=.env scripts/seed-studio-flow.ts"
```

`pnpm pkg set` rather than editing `package.json` by hand — the house rule.

- [ ] **Step 4: Dry-run it, and read the backup**

```bash
pnpm seed:studio
cat .superpowers/t14b/flow-FW*-revision-*.json | python3 -m json.tool | head -40
```

Expected: the live flow's name, status and state count; a backup path; the two states it would publish;
and `DRY RUN. Nothing was changed.` **Confirm the backup file exists and parses before continuing** —
that is the whole point of the dry run.

⚠ `.superpowers/` is already in the repo (it holds T14's backups). Confirm it is gitignored before the
first `--write`, since a flow definition can carry account-specific values.

- [ ] **Step 5: Publish**

```bash
pnpm seed:studio --write
```

Expected: `published: revision <N> status=published` then
`confirmed: connect_to_softphone dials client:browser_agent`.

Billed traffic is authorized on this account, and this is a metadata mutation rather than traffic — but
it is a mutation, so the backup above is the thing that makes it safe.

- [ ] **Step 6: Commit**

```bash
git add scripts/studio-handoff-flow.ts scripts/seed-studio-flow.ts package.json
git commit -m "T14b.9: the handoff flow as a committed definition, published behind a re-read backup"
```

---

### Task 10: Verify end-to-end on a real call, then make the docs true

Everything below rung 6 has already been proven for free. This task spends money once, deliberately,
and then writes down what happened.

**Files:**
- Modify: `docs/HANDOFF.md`
- Test: a real phone call.

- [ ] **Step 1: Confirm the process is running the code you just committed**

```bash
lsof -ti :8910 -sTCP:LISTEN | xargs -r ps -o pid=,lstart= -p
git log -1 --format=%cd
```

**The process start time must be AFTER the last commit.** Node does not hot-reload. This check exists
because a fix once looked broken on a live call for 53 minutes purely because the process predated it —
and note the asymmetry that made it confusing: Langfuse **prompts** DO refresh at run time behind a ~20 s
TTL, so a prompt change can land on the same call that a code change does not.

⚠ Use `-sTCP:LISTEN`. A bare `lsof -ti :8910` also matches ngrok's *connection* to the port, and
`xargs kill` on that output takes the tunnel down — three self-inflicted "the tunnel keeps dropping"
incidents came from exactly that.

- [ ] **Step 2: Register the softphone and leave the tab open**

Open <http://localhost:3000/softphone>, press **Register**, confirm `browser_agent — registered`.

⚠ One identity allows **10 concurrent registrations** and the 11th evicts the oldest. Two tabs are fine;
a page that has been hot-reloading all afternoon may have leaked several.

- [ ] **Step 3: Place the call — rung 6**

Call the demo number, ask a policy question first (so the transcript has something in it), then say
**"can I speak to a person?"**

Confirm all six, in order:
1. The agent says one short line about putting you through — and you hear **all** of it. A truncated
   line means the frame went out before the farewell finished streaming.
2. There is a pause of roughly a second or two, not silence-then-nothing. (`end_call` measured a 1.75 s
   gap while ConversationRelay drained queued audio; the same mechanism applies here.)
3. The softphone **rings**.
4. The screen pop shows the reason, the match quality, and the transcript **including the line you just
   said** — that last part is what proves the snapshot is taken at drain time rather than inside the tool.
5. Answering connects you to yourself. Speak both ways.
6. One `conversation.voice` trace in Langfuse holds every turn plus a `handoff` event.

- [ ] **Step 4: Re-verify the path this task deliberately changed**

`<Hangup/>` on the no-handoff path is a **behaviour change on a working path**: today TAC answers that
callback with `text/plain "OK"` and Twilio drops the call, and `docs/HANDOFF.md` records that no alert is
raised. Owning the route makes returning TwiML unavoidable.

So place a second call, say nothing about a human, and end it the old way — say "that's everything,
thanks" and let the agent hang up. Confirm the goodbye is heard in full, the call ends, and the Twilio
debugger shows **no** TwiML warning where it previously did.

- [ ] **Step 5: Measure the one thing that could quietly cost T14's memory story**

A handed-off conversation stops calling `/webhook` permanently — `clearStatusCallbacks` has no inverse
anywhere in TAC. So it may never produce a `CONVERSATION_UPDATED` / CLOSED event, and Conversation
Memory extraction for it may therefore never fire.

Wait out `statusTimeouts.closed` (5 minutes, timed from creation), then:

```bash
node --env-file-if-exists=.env scripts/verify-memory.ts
```

Record the answer either way. If extraction did not fire for the handed-off conversation, that is a real
limit of this feature and belongs in `docs/HANDOFF.md` as a measurement, not a caveat — it is the one
place T14b could silently degrade T14.

- [ ] **Step 6: Fold the findings into `docs/HANDOFF.md`**

Replace the `T14b, NOT STARTED` section with a `T14b, DONE` one. It must carry:

- The **seven corrections in this plan** (C1–C7), each with what was read to find it. C7 in particular
  supersedes the design doc's `json_object` claim.
- The **six corrections in the design doc** §2 and its two hazards §3, since HANDOFF is the entry point
  and the spec is not.
- The answer to §3.1's open question: **does a hyphen-free identity register?** (Task 7 Step 6.)
- The **measured** version of the drain: whether the caller hears the whole line, and the observed gap.
- The Step 5 memory-extraction result.
- The honest limits, unchanged from the design doc §10 and worth restating because each is a thing a
  future reader will otherwise rediscover: `recent`-match crossing under concurrency, the transcript as a
  new PII surface, the 10-registration cap, and the unenforced 7-day supply-chain guard.

⚠ `docs/HANDOFF.md` carries **no account-specific values** — no SIDs, no phone number, no flow SID. That
rule is why this repo can be cloned. Those live in `.env` and in session memory.

- [ ] **Step 7: Final verification and commit**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS, ~320 tests / 19 files.

```bash
git add docs/HANDOFF.md
git commit -m "T14b.10: verified on a real call — and the two things that turned out not to be true"
```

---

## Self-review against the spec

Checked section by section after writing. Recorded here rather than deleted, because the gaps are the
useful part.

**Covered:** §1 goal (Tasks 3–7); §2.1 our own action route (Task 4); §2.2 `actionUrl` precedence, proven
on the live process (Task 4 Step 8); §2.3 one tool (Task 2); §2.4 the ready-made frame and the drain
(Tasks 2–3); §2.5 the INACTIVE landmine mitigated by sending the frame (Task 2 test 2); §2.6 no TwiML App
and the `twilio` dependency (Task 5); §3.1 hyphen-free identity (Tasks 1, 7, 9); §3.2 correlation ladder
(Tasks 2, 4, 6); §4 architecture (Tasks 2–7); §5 components (all, with C1/C3 relocations); §6
`end_call` versus handoff (Task 3); §7 error handling (Tasks 2, 4, 5); §8 account changes (Task 9,
narrowed by C7); §9 the verification ladder in order — rungs 1–5 free in Tasks 1–7, rung 6 in Task 10;
§10 honest limits (Task 10 Step 6); §11 omissions respected — no live memory panel, no outbound calling,
no Flex, no voicemail, no second flow.

**Deliberately not covered, and each one is a decision rather than an oversight:**

- **Naming `handoff` in the text prompt** (spec §5). See C5. One line to reverse.
- **The `set-variables` / `json_object` widget** (spec §8). See C7 — it cannot work behind our own action
  route, and it is not needed.
- **A vitest file for the softphone.** `web/` has no test runner; adding one is its own task. Task 7's
  verification is a browser and a screenshot.
- **Twilio signature validation on the action route.** Needs `validateRequest` from the `twilio` package,
  which is confined to `server/twilio/`. Task 4's header states the exposure precisely and names the
  injection seam if it is ever wanted.

**Two open questions the plan does not answer, and cannot:**

1. **Does the Studio `<Redirect>` reach a published flow cleanly on the first try?** The URL shape is
   TAC's own and the definition matches the published schema, but nothing short of a real call proves the
   pair. Task 9 Step 5 confirms what landed; Task 10 Step 3 is where it either works or names its error.
2. **Does extraction still fire for a handed-off conversation?** Task 10 Step 5 measures it. If it does
   not, T14's memory demo and T14b's transfer demo cannot be shown on the same conversation, which is
   worth knowing before a customer sees both.
