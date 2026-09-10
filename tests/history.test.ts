import { test, expect } from 'vitest';
import {
  createHistory,
  HISTORY_MAX_CONVERSATIONS,
  HISTORY_MAX_MESSAGES,
} from '../server/agent/history.ts';
import type { TurnMessage } from '../server/agent/types.ts';

/**
 * No mocking library, no snapshots — the limits are injected, which is the only seam this module
 * needs. Tests use tiny caps so eviction is provoked in four messages rather than twenty.
 *
 * The two assertions worth naming, because they are the ones a lazier implementation passes:
 *
 *  1. Eviction is asserted by OBSERVING A DROP, not by reading a size counter. A `size()` that is
 *     decremented without the entry actually leaving the map passes a counter assertion.
 *  2. LRU is asserted through `read`, not only `append`. A store that refreshes recency on write
 *     alone evicts the conversation a caller is actively reading from — which on voice is the
 *     live call, and the symptom is an agent that forgets mid-conversation under load.
 */

const user = (content: string): TurnMessage => ({ role: 'user', content });
const assistant = (content: string): TurnMessage => ({ role: 'assistant', content });

const texts = (messages: readonly TurnMessage[]): readonly string[] => messages.map((m) => m.content);

// ------------------------------------------------------------------ basics

test('an unseen conversation reads as empty rather than undefined', () => {
  const history = createHistory();
  expect(history.read('never-seen')).toEqual([]);
});

test('appended messages read back in the order they were appended', () => {
  const history = createHistory();
  history.append('c1', [user('hello'), assistant('hi there')]);
  history.append('c1', [user('and again')]);

  expect(texts(history.read('c1'))).toEqual(['hello', 'hi there', 'and again']);
});

test('two conversations do not leak into each other', () => {
  const history = createHistory();
  history.append('c1', [user('for one')]);
  history.append('c2', [user('for two')]);

  expect(texts(history.read('c1'))).toEqual(['for one']);
  expect(texts(history.read('c2'))).toEqual(['for two']);
});

test('clear drops one conversation and leaves its neighbours alone', () => {
  const history = createHistory();
  history.append('c1', [user('one')]);
  history.append('c2', [user('two')]);

  history.clear('c1');

  expect(history.read('c1')).toEqual([]);
  expect(texts(history.read('c2'))).toEqual(['two']);
});

test('clearing an unknown conversation is a no-op, not a throw', () => {
  const history = createHistory();
  // T13 calls this from `conversationEnded` AND `webSocketDisconnected`, so a double-clear on the
  // same id is the normal case, not an edge one. Throwing here would surface inside a TAC handler
  // whose errors are swallowed and only logged.
  expect(() => history.clear('never-seen')).not.toThrow();
  history.append('c1', [user('one')]);
  history.clear('c1');
  expect(() => history.clear('c1')).not.toThrow();
});

test('appending nothing does not create an entry', () => {
  const history = createHistory();
  history.append('c1', []);
  expect(history.size()).toBe(0);
});

// ------------------------------------------------------------------ cap 1: messages per conversation

test('the newest messages survive the per-conversation cap and the oldest are dropped', () => {
  const history = createHistory({ maxMessages: 4, maxConversations: 10 });

  history.append('c1', [user('turn 1'), assistant('reply 1')]);
  history.append('c1', [user('turn 2'), assistant('reply 2')]);
  history.append('c1', [user('turn 3'), assistant('reply 3')]);

  // Six appended, four kept: the two oldest are gone and the most recent exchange is intact.
  expect(texts(history.read('c1'))).toEqual(['turn 2', 'reply 2', 'turn 3', 'reply 3']);
});

test('a single append larger than the cap is trimmed to the newest messages', () => {
  const history = createHistory({ maxMessages: 2, maxConversations: 10 });

  history.append('c1', [user('a'), assistant('b'), user('c'), assistant('d')]);

  expect(texts(history.read('c1'))).toEqual(['c', 'd']);
});

// ------------------------------------------------------------------ cap 2: conversations in the map

test('the least recently used conversation is evicted when the map is full', () => {
  const history = createHistory({ maxMessages: 10, maxConversations: 2 });

  history.append('c1', [user('one')]);
  history.append('c2', [user('two')]);
  history.append('c3', [user('three')]);

  // Observed as a DROP, not as a counter: c1 was least recently used, so it is the one that went.
  expect(history.read('c1')).toEqual([]);
  expect(texts(history.read('c2'))).toEqual(['two']);
  expect(texts(history.read('c3'))).toEqual(['three']);
  expect(history.size()).toBe(2);
});

test('reading a conversation protects it from eviction', () => {
  const history = createHistory({ maxMessages: 10, maxConversations: 2 });

  history.append('c1', [user('one')]);
  history.append('c2', [user('two')]);

  // c1 is now the least recently WRITTEN, but reading it makes it the most recently USED. A store
  // that tracks recency on write alone evicts the conversation someone is actively talking to.
  history.read('c1');
  history.append('c3', [user('three')]);

  expect(texts(history.read('c1'))).toEqual(['one']);
  expect(history.read('c2')).toEqual([]);
});

test('appending to an existing conversation refreshes it without growing the map', () => {
  const history = createHistory({ maxMessages: 10, maxConversations: 2 });

  history.append('c1', [user('one')]);
  history.append('c2', [user('two')]);
  history.append('c1', [user('one again')]);

  expect(history.size()).toBe(2);
  expect(texts(history.read('c1'))).toEqual(['one', 'one again']);
});

// ------------------------------------------------------------------ eviction is not silent

test('evicting a conversation is reported, because it means an agent silently forgot', () => {
  const warnings: string[] = [];
  const history = createHistory(
    { maxMessages: 10, maxConversations: 1 },
    { debug: () => {}, warn: (_fields, msg) => void warnings.push(msg), error: () => {} },
  );

  history.append('c1', [user('one')]);
  expect(warnings).toEqual([]);

  history.append('c2', [user('two')]);

  // Hitting the CONVERSATION cap means a box has been up long enough to lose state nobody asked it
  // to lose. That is worth one line naming the id, so "the agent forgot mid-call" is diagnosable
  // rather than a mystery.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('c1');
});

test('trimming messages within a conversation is NOT warned about', () => {
  const warnings: string[] = [];
  const history = createHistory(
    { maxMessages: 2, maxConversations: 10 },
    { debug: () => {}, warn: (_fields, msg) => void warnings.push(msg), error: () => {} },
  );

  history.append('c1', [user('a'), assistant('b')]);
  history.append('c1', [user('c'), assistant('d')]);

  // Steady state, not degradation: every conversation past the cap trims on every turn, so warning
  // here would put a line in the log for each turn of every long call and bury the eviction above.
  expect(texts(history.read('c1'))).toEqual(['c', 'd']);
  expect(warnings).toEqual([]);
});

// ------------------------------------------------------------------ isolation of the returned array

test('mutating what read returned does not corrupt the store', () => {
  const history = createHistory();
  history.append('c1', [user('one')]);

  const first = history.read('c1') as TurnMessage[];
  first.push(assistant('injected'));

  expect(texts(history.read('c1'))).toEqual(['one']);
});

test('mutating the array passed to append does not change what was stored', () => {
  const history = createHistory();
  const batch: TurnMessage[] = [user('one')];
  history.append('c1', batch);
  batch.push(assistant('injected'));

  expect(texts(history.read('c1'))).toEqual(['one']);
});

// ------------------------------------------------------------------ the shipped defaults

test('the default caps are bounded and leave room for a real conversation', () => {
  // The point of the assertion is that BOTH dimensions are finite. A demo box runs for a week;
  // an unbounded map is a slow leak that no test would otherwise notice.
  expect(Number.isFinite(HISTORY_MAX_MESSAGES)).toBe(true);
  expect(Number.isFinite(HISTORY_MAX_CONVERSATIONS)).toBe(true);
  // An even message cap keeps whole user/assistant exchanges rather than half of one.
  expect(HISTORY_MAX_MESSAGES % 2).toBe(0);
  expect(HISTORY_MAX_MESSAGES).toBeGreaterThanOrEqual(6);
  expect(HISTORY_MAX_CONVERSATIONS).toBeGreaterThanOrEqual(10);
});

test('the default store enforces the default caps', () => {
  const history = createHistory();
  for (let i = 0; i < HISTORY_MAX_MESSAGES + 4; i++) history.append('c1', [user(`m${i}`)]);

  expect(history.read('c1')).toHaveLength(HISTORY_MAX_MESSAGES);
  // The newest survived, the oldest did not.
  expect(texts(history.read('c1')).at(-1)).toBe(`m${HISTORY_MAX_MESSAGES + 3}`);
  expect(texts(history.read('c1'))).not.toContain('m0');
});
