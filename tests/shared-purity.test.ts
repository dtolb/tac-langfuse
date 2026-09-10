import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { AGENT_PORT, WEB_PORT, LANGFUSE_HOST_PORT } from '../shared/ports.ts';
import { TAC_WEBHOOK_PATHS, APP_API_PATHS } from '../shared/twilio-paths.ts';

/**
 * shared/ is compiled by BOTH tsconfig projects — the node one and web's. That is a
 * structural guarantee that it holds data rather than behaviour, but only while nothing in
 * there reaches for an environment-specific global. `tsc` catches most of it via the
 * `types` settings; this catches the rest, and catches it in a way that names the rule.
 */

const SHARED_DIR = new URL('../shared/', import.meta.url).pathname;

const sharedFiles = (): string[] =>
  readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts'));

/**
 * Strip comments before scanning.
 *
 * Without this the guard is unusable: a doc comment saying "before it leaves the process."
 * trips `/\bprocess\./`, so the only way to keep the test green is to avoid writing about the
 * very constraints the file exists to explain. A guard that punishes documentation gets
 * deleted. The `:` check keeps `https://` inside string literals intact.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const codeOf = (file: string): string => stripComments(readFileSync(join(SHARED_DIR, file), 'utf8'));

test('shared/ has files to police', () => {
  // Tripwire: without this, renaming shared/ turns every assertion below into a no-op.
  expect(sharedFiles().length).toBeGreaterThan(0);
});

test('TRIPWIRE: comment stripping does not hide real code', () => {
  // If stripComments over-reaches, every purity assertion below silently passes.
  expect(stripComments('const a = 1; // process.env\n')).toContain('const a = 1;');
  expect(stripComments('/** leaves the process. */\nconst b = 2;')).not.toContain('process.');
  expect(stripComments('const c = process.env.X;')).toContain('process.env.X');
  expect(stripComments(`const u = 'https://x.com';`)).toContain('https://x.com');
});

test('shared/ touches no Node global', () => {
  const banned = [/\bprocess\./, /\b__dirname\b/, /\b__filename\b/, /\brequire\(/, /from 'node:/];
  for (const file of sharedFiles()) {
    const src = codeOf(file);
    for (const pattern of banned) {
      expect(pattern.test(src), `${file} must not use ${pattern}`).toBe(false);
    }
  }
});

test('shared/ touches no DOM global', () => {
  const banned = [/\bwindow\./, /\bdocument\./, /\blocalStorage\b/, /\bnavigator\./];
  for (const file of sharedFiles()) {
    const src = codeOf(file);
    for (const pattern of banned) {
      expect(pattern.test(src), `${file} must not use ${pattern}`).toBe(false);
    }
  }
});

test('ports are distinct, so nothing silently shadows another listener', () => {
  const ports = [AGENT_PORT, WEB_PORT, LANGFUSE_HOST_PORT];
  expect(new Set(ports).size).toBe(ports.length);
});

test('agent port avoids every known occupant on this machine', () => {
  // 8080 — the dev box publishes Traefik's dashboard there. Binding it makes Fastify log
  //        four happy "Server listening" lines while every localhost request is answered by
  //        Traefik's plain-text 404 instead.
  // 8787 — nw-poc and aci-quality-poc both hard-code it, so sharing it means this scaffold
  //        cannot run at the same time as the demos it was cloned from.
  // 8000 — TAC's default; an explicit port can never be accidentally right.
  // 3030 — langfuse-worker.
  for (const taken of [8080, 8787, 8000, 3030]) {
    expect(AGENT_PORT, `${taken} is already claimed`).not.toBe(taken);
  }
});

test('TAC and app path prefixes do not overlap', () => {
  // They are split by path at Traefik across two containers, so an overlap sends traffic to
  // the wrong service — and it surfaces as a 404 that looks like a Twilio problem.
  for (const tac of TAC_WEBHOOK_PATHS) {
    for (const app of APP_API_PATHS) {
      expect(tac.startsWith(app), `${tac} overlaps ${app}`).toBe(false);
      expect(app.startsWith(tac), `${app} overlaps ${tac}`).toBe(false);
    }
  }
});

test('every path prefix is rooted and has no trailing slash', () => {
  for (const p of [...TAC_WEBHOOK_PATHS, ...APP_API_PATHS]) {
    expect(p.startsWith('/'), `${p} must start with /`).toBe(true);
    expect(p.endsWith('/'), `${p} must not end with /`).toBe(false);
  }
});
