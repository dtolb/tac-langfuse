import { test, expect } from 'vitest';
import { scrubPii, scrubObject, maskPhone, piiLogMethod } from '../server/obs/pii.ts';

/**
 * These assertions are pinned against TAC's own scrubber behaviour. We keep a separate copy
 * (see server/obs/pii.ts for why), so the risk is the two drifting into disagreeing about
 * what counts as sensitive — that is what this file exists to prevent.
 */

test('masks phone numbers in free text', () => {
  expect(scrubPii('call me on +15551234567 today')).toBe('call me on +1***4567 today');
  expect(scrubPii('+1 (555) 123-4567')).toBe('+1***4567');
});

test('masks email addresses in free text', () => {
  expect(scrubPii('write to dan@example.com please')).toBe('write to d***@example.com please');
});

test('leaves ordinary text alone', () => {
  const plain = 'Refunds take two business days.';
  expect(scrubPii(plain)).toBe(plain);
});

test('does not mangle short digit runs that are not phone numbers', () => {
  // Order totals, line numbers and latencies must survive — a scrubber that eats them makes
  // the log useless for the thing we built it for.
  expect(scrubPii('turn.ttft_ms=412 total=1840')).toBe('turn.ttft_ms=412 total=1840');
  expect(scrubPii('order 12345 shipped')).toBe('order 12345 shipped');
});

test('maskPhone handles a known-E.164 value and rejects junk', () => {
  expect(maskPhone('+15551234567')).toBe('+1***4567');
  expect(maskPhone('555')).toBe('***');
  expect(maskPhone(undefined)).toBe('***');
  expect(maskPhone('not a number')).toBe('***');
});

test('scrubs nested objects and arrays', () => {
  const input = {
    caller: '+15551234567',
    turns: [{ text: 'reach me at dan@example.com' }],
    latencyMs: 412,
  };
  expect(scrubObject(input)).toEqual({
    caller: '+1***4567',
    turns: [{ text: 'reach me at d***@example.com' }],
    latencyMs: 412,
  });
});

test('survives a cycle instead of throwing', () => {
  const a: Record<string, unknown> = { phone: '+15551234567' };
  a.self = a;
  const out = scrubObject(a) as Record<string, unknown>;
  expect(out.phone).toBe('+1***4567');
  expect(out.self).toBe('[Circular]');
});

test('scrubs an Error while preserving its prototype and stack', () => {
  const err = new TypeError('failed calling +15551234567');
  const out = scrubObject(err) as Error;
  expect(out).toBeInstanceOf(TypeError);
  expect(out.message).toBe('failed calling +1***4567');
  expect(out.stack).toBeDefined();
  expect(out.stack).not.toContain('+15551234567');
});

test('passes non-plain objects through untouched', () => {
  // A logger must never walk or mutate a live handle. Identity, not equality.
  // Written the long way on purpose: `constructor(readonly phone: string)` is a parameter
  // property, which `erasableSyntaxOnly` rejects — Node's native type stripping cannot
  // execute it, so the flag turns it into a compile error instead of a boot crash.
  class Session {
    phone: string;
    constructor(phone: string) {
      this.phone = phone;
    }
  }
  const s = new Session('+15551234567');
  expect(scrubObject(s)).toBe(s);
  const d = new Date(0);
  expect(scrubObject(d)).toBe(d);
});

test('piiLogMethod scrubs every argument before the real method sees them', () => {
  const seen: unknown[] = [];
  const method = (...args: unknown[]): void => void seen.push(...args);
  piiLogMethod.call({}, [{ caller: '+15551234567' }, 'to dan@example.com', 42], method);
  expect(seen).toEqual([{ caller: '+1***4567' }, 'to d***@example.com', 42]);
});
