import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'vitest';

/**
 * `.env.example` is documentation that rots silently: someone reads a new variable in code,
 * the next person clones the scaffold, and the demo fails for a reason nothing explains.
 * This test makes that rot a build failure.
 */

const ROOT = new URL('..', import.meta.url).pathname;

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|mjs)$/.test(full)) out.push(full);
  }
  return out;
};

const example = (): string => readFileSync(join(ROOT, '.env.example'), 'utf8');

/** Variables the code reads but which are supplied by the platform, not by .env. */
const NOT_OURS = new Set(['NODE_ENV', 'PATH', 'HOME', 'npm_lifecycle_event']);

const readVariables = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const file of [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'scripts'))]) {
    const src = readFileSync(file, 'utf8');
    // process.env.FOO and process.env['FOO'] and env.FOO inside loadConfig's pick(...) list
    for (const m of src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
      const name = m[1] ?? m[2];
      if (!name || NOT_OURS.has(name)) continue;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
    // Names passed as string literals to pick(env, 'TWILIO_X', ...) in config.ts
    for (const m of src.matchAll(/'(TWILIO_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|LANGFUSE_[A-Z0-9_]+|APP_NAME)'/g)) {
      const name = m[1];
      if (!name || NOT_OURS.has(name)) continue;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
};

test('TRIPWIRE: .env.example exists and is substantial', () => {
  // A stub file would make every assertion below pass while documenting nothing.
  const text = example();
  expect(text.length).toBeGreaterThan(2000);
});

test('TRIPWIRE: the scanner finds variables to check', () => {
  expect(readVariables().size).toBeGreaterThan(5);
});

test('every variable the code reads is documented in .env.example', () => {
  const text = example();
  const undocumented = [...readVariables().entries()]
    .filter(([name]) => !text.includes(name))
    .map(([name, files]) => `${name} (read in ${files[0]})`);
  expect(undocumented, 'add these to .env.example, with what breaks when absent').toEqual([]);
});

test('each documented variable says what breaks, not just what it is', () => {
  // The convention that makes these files worth reading: cause AND consequence.
  const text = example();
  for (const marker of ['FAILURE MODE', 'Format:', 'Console →']) {
    expect(text.includes(marker), `.env.example should use "${marker}" to explain variables`).toBe(true);
  }
});

test('.env.example carries the "NOT set here on purpose" section', () => {
  // Scope honesty as a first-class artifact — the deliberate omissions are as informative as
  // the settings, and without this section someone "helpfully" adds a PORT variable.
  expect(example()).toContain('NOT set here on purpose');
});

test('the Langfuse init keys match the client keys', () => {
  // Headless init creates the project with the INIT values; the client authenticates with the
  // other pair. If they drift, the stack comes up healthy and every API call 401s.
  const text = example();
  const get = (name: string): string | undefined =>
    text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

  expect(get('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')).toBe(get('LANGFUSE_PUBLIC_KEY'));
  expect(get('LANGFUSE_INIT_PROJECT_SECRET_KEY')).toBe(get('LANGFUSE_SECRET_KEY'));
});

test('no LANGFUSE_INIT_* value is quoted', () => {
  // Langfuse's own troubleshooting note: quoted values in docker compose break init.
  for (const line of example().split('\n')) {
    const m = line.match(/^(LANGFUSE_INIT_[A-Z_]+)=(.*)$/);
    if (!m) continue;
    const value = (m[2] ?? '').trim();
    expect(/^["']|["']$/.test(value), `${m[1]} must not be quoted`).toBe(false);
  }
});

test('.env.example contains no real-looking secret', () => {
  // It is committed. A pasted key here is a leaked key.
  const text = example();
  expect(/sk-proj-[A-Za-z0-9_-]{20,}/.test(text), 'a real OpenAI key is in .env.example').toBe(false);
  expect(/\bSK[0-9a-f]{32}\b/.test(text), 'a real Twilio API key is in .env.example').toBe(false);
  expect(/\bAC[0-9a-f]{32}\b/.test(text), 'a real Twilio account SID is in .env.example').toBe(false);
});
