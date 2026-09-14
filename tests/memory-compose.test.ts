import { test, expect } from 'vitest';
import {
  createTacMemoryPort,
  type ProfileFetcher,
} from '../server/twilio/memory-compose.ts';
import type { ToolLogger } from '../server/agent/tools/registry.ts';
import { createObsBus } from '../server/obs/bus.ts';
import type { ObsEvent } from '../shared/events.ts';

/**
 * The TAC memory compose port.
 *
 * ONLY `fetchProfile` IS FAKED. The parse, the communications guard and the whole of the rendering
 * run the REAL `twilio-agent-connect@2.2.0` code, and that is the point rather than an accident:
 * the middle test asserts that a section TAC's own renderer WOULD emit does not appear, which proves
 * nothing at all if the renderer is a stub. Verified by removing the guard — see its comment.
 *
 * Recall payloads are plain object literals, not `TACMemoryResponse` instances. Measured: the picked
 * schema reads a literal's properties and a real instance's getters identically, so a literal drives
 * the same code path with three lines instead of a vendor constructor whose communications must
 * satisfy `TACCommunicationSchema`.
 */

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

/** Any string TAC's `ObservationInfoSchema` will accept as `createdAt` — it wants strict ISO. */
const AT = '2026-09-01T12:00:00.000Z';

const observation = (content: string): Record<string, unknown> => ({
  id: `obs_${content.length}`,
  content,
  createdAt: AT,
});

/**
 * A communication in the shape the Memory API returns and TAC's fallback path re-wraps: an author
 * with `type: 'CUSTOMER'`, which is what makes the renderer label the line `User:` rather than
 * `Assistant:` (`tac-memory-response.ts:185`).
 */
const communication = (text: string): Record<string, unknown> => ({
  id: 'comm_1',
  author: { id: 'p_1', type: 'CUSTOMER', address: '+19195550123', channel: 'SMS' },
  content: { text },
  recipients: [],
  createdAt: AT,
});

/** Records every profile id it was asked for, so "did not fetch" is assertable. */
const recordingFetcher = (
  traits?: Record<string, unknown>,
): { fetcher: ProfileFetcher; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    fetcher: {
      fetchProfile: async (profileId) => {
        asked.push(profileId);
        return traits === undefined ? undefined : { traits };
      },
    },
  };
};

const turn = { conversationId: 'CH_test', channel: 'sms' } as const;

// ------------------------------------------------------------------ what memory contributes

test('observations reach the composed context', async () => {
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(composed).toContain('- Prefers the window seat');
});

test('observations are rendered under TAC’s own heading, not one of ours', async () => {
  // Pins that the section comes from `buildMemoryPrompts()`. If someone replaces the renderer with
  // hand-rolled strings, the phrasing drifts and this is what notices.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: { observations: [observation('Ordered twice last month')], summaries: [] },
  });

  expect(composed).toContain('## Key Observations');
});

test('fetched profile traits render as a Customer Profile section', async () => {
  // The measured shape on this account: traits nested and keyed by trait GROUP, not flat.
  const { fetcher } = recordingFetcher({ Contact: { phone: '+19195550123' } });
  const port = createTacMemoryPort(fetcher, { logger: silentLogger, bus: createObsBus() });

  const composed = await port.compose({
    ...turn,
    profileId: 'mem_profile_abc',
    memory: { observations: [observation('Prefers email')], summaries: [] },
  });

  expect(composed).toContain('## Customer Profile');
});

// ------------------------------------------------------------------ THE GUARD

test('a response that DOES carry communications renders no Recent Message History heading', async () => {
  /**
   * THE reason this file exists. `server/agent/history.ts` already puts this conversation into the
   * model's messages; a recall whose communications reach the system prompt shows it a second copy
   * in a second format.
   *
   * PROVEN TO BITE. Replacing the guarded construction in `memory-compose.ts` with
   * `new TACMemoryResponse(memory)` — the payload's own arrays, straight to the renderer — failed
   * this test with:
   *
   *   AssertionError: expected '# Customer Context\nYou have access t…' not to contain
   *   '## Recent Message History'
   *
   * over a received string carrying `## Recent Message History` / `User: where is my order` directly
   * under the observations. The `User:` assertion below and the fallback-shape assertion failed the
   * same way; the other fifteen tests in this file passed throughout, so those three are the only
   * thing holding the property. Restored, all eighteen pass.
   */
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: {
      observations: [observation('Prefers the window seat')],
      summaries: [],
      communications: [communication('where is my order')],
    },
  });

  expect(composed).not.toContain('## Recent Message History');
});

test('a response that DOES carry communications renders no User: line', async () => {
  // The heading and the lines are separate claims: a renderer could drop the heading and still leak
  // the transcript, which is the half that actually confuses the model.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: {
      observations: [observation('Prefers the window seat')],
      summaries: [],
      communications: [communication('where is my order')],
    },
  });

  expect(composed).not.toContain('User:');
});

test('the Recall-failure fallback shape contributes nothing at all', async () => {
  /**
   * Flow A-prime's error path, which no config value protects: when Recall throws, TAC calls
   * `listCommunications(conversationId)` and wraps THIS conversation's messages in a
   * `TACMemoryResponse` whose observations and summaries are empty. Reproduced here as the payload
   * shape that arrives — communications only.
   */
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: {
      observations: [],
      summaries: [],
      communications: [communication('this very conversation, echoed back')],
    },
  });

  expect(composed).toBeNull();
});

// ------------------------------------------------------------------ never throws, never ''

test('a payload whose internals throw returns null rather than propagating', async () => {
  // A getter that throws is how a vendor object misbehaves in practice, and zod's `safeParse` does
  // NOT contain it (measured) — it propagates, which is exactly what the outer guard is for.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: {
      get observations(): never {
        throw new Error('recall payload exploded');
      },
    },
  });

  expect(composed).toBeNull();
});

test('a compose failure is reported once, on memory.recall', async () => {
  // Logged AND published, because a memory that silently stops working looks like a model that got
  // worse. `error` is deliberately not the kind used: this is a degraded step, not a failed turn.
  const events: ObsEvent[] = [];
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));
  const port = createTacMemoryPort(recordingFetcher().fetcher, { logger: silentLogger, bus });

  await port.compose({
    ...turn,
    profileId: null,
    memory: {
      get observations(): never {
        throw new Error('recall payload exploded');
      },
    },
  });

  expect(events.map((e) => e.kind)).toEqual(['memory.recall']);
});

test('a profile fetch failure costs the profile section and nothing else', async () => {
  // The inner catch. The outer one returns null, which would throw away observations we already
  // have — so a failing fetch must not reach it.
  const failing: ProfileFetcher = {
    fetchProfile: () => Promise.reject(new Error('Memory API 503')),
  };
  const port = createTacMemoryPort(failing, { logger: silentLogger, bus: createObsBus() });

  const composed = await port.compose({
    ...turn,
    profileId: 'mem_profile_abc',
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(composed).toContain('- Prefers the window seat');
});

test('no data at all composes to null, not an empty string', async () => {
  // `''` would be appended to the system prompt as a blank paragraph. `run-turn.ts` guards it too;
  // this is the half of that belt-and-braces that lives here.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: null,
    memory: { observations: [], summaries: [] },
  });

  expect(composed).toBeNull();
});

test('an absent memory payload composes to null', async () => {
  // `memoryMode: 'never'`, which is what both channels ship with at T13 — the steady state.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  expect(await port.compose({ ...turn, profileId: null, memory: null })).toBeNull();
});

test('a payload that is not a recall response at all composes to null', async () => {
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  expect(await port.compose({ ...turn, profileId: null, memory: 'not a recall' })).toBeNull();
});

// ------------------------------------------------------------------ the profile round-trip

test('profileId null skips the profile fetch entirely', async () => {
  // Not "returns no section" — never asks. The fetch is a Conversation Orchestrator round-trip in
  // front of the first spoken word, and there is nothing to key it on.
  const { fetcher, asked } = recordingFetcher({ Contact: { phone: '+19195550123' } });
  const port = createTacMemoryPort(fetcher, { logger: silentLogger, bus: createObsBus() });

  await port.compose({
    ...turn,
    profileId: null,
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(asked).toEqual([]);
});

test('an absent memory payload skips the profile fetch too', async () => {
  // The early return is in front of the fetch on purpose: memory off must mean no round-trip.
  const { fetcher, asked } = recordingFetcher({ Contact: { phone: '+19195550123' } });
  const port = createTacMemoryPort(fetcher, { logger: silentLogger, bus: createObsBus() });

  await port.compose({ ...turn, profileId: 'mem_profile_abc', memory: null });

  expect(asked).toEqual([]);
});

test('a non-null profileId is fetched exactly once', async () => {
  const { fetcher, asked } = recordingFetcher({ Contact: { phone: '+19195550123' } });
  const port = createTacMemoryPort(fetcher, { logger: silentLogger, bus: createObsBus() });

  await port.compose({
    ...turn,
    profileId: 'mem_profile_abc',
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(asked).toEqual(['mem_profile_abc']);
});

test('the fetch cost is reported as profileMs so memory.recall’s duration is attributable', async () => {
  // The reason this port publishes no span of its own: `run-turn.ts` already times the whole call,
  // and this number is what says whether that time was the round-trip or something else.
  const events: ObsEvent[] = [];
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));
  // Injected clock: one tick per `now()` call, so the reported figure is exact rather than tolerant.
  let clock = 0;
  const port = createTacMemoryPort(recordingFetcher({ Contact: { phone: '+1' } }).fetcher, {
    logger: silentLogger,
    bus,
    now: () => (clock += 10),
  });

  await port.compose({
    ...turn,
    profileId: 'mem_profile_abc',
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(events[0]?.payload?.profileMs).toBe(10);
});

test('profileMs is null when no fetch was attempted, not 0', async () => {
  // 0 would read as a fetch that cost nothing, which is a different and untrue claim.
  const events: ObsEvent[] = [];
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));
  const port = createTacMemoryPort(recordingFetcher().fetcher, { logger: silentLogger, bus });

  await port.compose({
    ...turn,
    profileId: null,
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(events[0]?.payload?.profileMs).toBeNull();
});

test('a profile with no traits contributes no section', async () => {
  // `fetchProfile` resolving `undefined` is TAC's own not-available answer (voice-only mode, or a
  // fetch it swallowed internally), so it is a normal path rather than an error.
  const port = createTacMemoryPort(recordingFetcher().fetcher, {
    logger: silentLogger,
    bus: createObsBus(),
  });

  const composed = await port.compose({
    ...turn,
    profileId: 'mem_profile_abc',
    memory: { observations: [observation('Prefers the window seat')], summaries: [] },
  });

  expect(composed).not.toContain('## Customer Profile');
});
