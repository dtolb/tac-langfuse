import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect } from 'vitest';

/**
 * Vendor-boundary enforcement.
 *
 * Every rule here exists because a vendor SDK leaking out of its designated directory
 * destroys something concrete:
 *
 *  - TAC outside server/twilio/ means `runTurn` is no longer channel-agnostic, and the
 *    Twilio-free bench stops being a runtime proof that it is.
 *  - `ai` outside agent/model/ means the provider is no longer swappable in one file.
 *  - `@langfuse/client` outside agent/prompt/ means prompt fetching is no longer behind a
 *    port, so the compiled-in fallback can't be tested.
 *  - `console.*` anywhere means a log line that bypasses the PII scrubber.
 *
 * Rules are expressed as data so the TRIPWIRE tests below can assert the rule set itself is
 * intact. Without those, renaming a directory turns a guard into a vacuous pass — the exact
 * failure mode `aci-quality-poc/tests/architecture.test.ts` was built to prevent.
 */

const ROOT = new URL('..', import.meta.url).pathname;

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts)$/.test(full)) out.push(full);
  }
  return out;
};

const rel = (f: string): string => relative(ROOT, f);
const read = (f: string): string => readFileSync(f, 'utf8');

/** Matches a real import/require of `spec` or any of its subpaths — not a mention in prose. */
const importsPackage = (src: string, spec: string): boolean => {
  const escaped = spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(
    `(?:from|import)\\s*\\(?\\s*['"]${escaped}(?:/[^'"]*)?['"]|require\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`,
  );
  return pattern.test(src);
};

interface Rule {
  readonly pkg: string;
  /** Only files whose repo-relative path starts with one of these may import `pkg`. */
  readonly allowedPrefixes: readonly string[];
  readonly why: string;
}

const RULES: readonly Rule[] = [
  {
    pkg: 'twilio-agent-connect',
    allowedPrefixes: ['server/twilio/', 'scripts/'],
    why: 'keeps runTurn channel-agnostic so the Twilio-free bench proves it at runtime',
  },
  {
    pkg: 'twilio',
    allowedPrefixes: ['server/twilio/', 'scripts/'],
    why: 'the raw Twilio SDK stops at the same boundary as TAC',
  },
  {
    pkg: 'ai',
    // instrumentation.ts is an explicit, narrow exception: it imports `registerTelemetry` only.
    // That is the AI SDK's telemetry hook, not model invocation, and it is provider-agnostic —
    // so it does not compromise what this rule protects. Registration must also happen in the
    // --import preload, which by definition cannot live behind the model port.
    allowedPrefixes: ['server/agent/model/', 'server/obs/instrumentation.ts', 'scripts/'],
    why: 'the LLM provider must stay swappable in one file (instrumentation.ts may use registerTelemetry only)',
  },
  {
    pkg: '@ai-sdk/openai',
    allowedPrefixes: ['server/agent/model/', 'scripts/'],
    why: 'same — provider choice is config, not architecture',
  },
  {
    pkg: '@langfuse/client',
    allowedPrefixes: ['server/agent/prompt/', 'scripts/'],
    why: 'prompt fetching sits behind PromptPort so the compiled-in fallback is testable',
  },
];

const sourceFiles = (): string[] => [
  ...walk(join(ROOT, 'server')),
  ...walk(join(ROOT, 'shared')),
  ...walk(join(ROOT, 'web', 'src')),
];

// ---------------------------------------------------------------- tripwires

test('TRIPWIRE: the rule set is non-empty', () => {
  // If someone empties RULES, every boundary test below passes for the wrong reason.
  expect(RULES.length).toBeGreaterThanOrEqual(5);
});

test('TRIPWIRE: there are source files to scan', () => {
  expect(sourceFiles().length).toBeGreaterThan(0);
});

test('TRIPWIRE: the import matcher actually matches', () => {
  // Guards against a regex edit that quietly makes every rule unfalsifiable.
  expect(importsPackage(`import { TAC } from 'twilio-agent-connect';`, 'twilio-agent-connect')).toBe(true);
  expect(importsPackage(`import x from 'twilio-agent-connect/sub';`, 'twilio-agent-connect')).toBe(true);
  expect(importsPackage(`const t = require('twilio-agent-connect');`, 'twilio-agent-connect')).toBe(true);
  // Must NOT fire on prose, or comments explaining the boundary would trip their own rule.
  expect(importsPackage(`// we deliberately do not import twilio-agent-connect here`, 'twilio-agent-connect')).toBe(false);
  // Must not treat `ai` as a prefix of an unrelated package.
  expect(importsPackage(`import { z } from 'zod';`, 'ai')).toBe(false);
  expect(importsPackage(`import x from 'aisle';`, 'ai')).toBe(false);
});

// ---------------------------------------------------------------- boundaries

test.each(RULES.map((r) => [r.pkg, r] as const))('%s stays inside its boundary', (_pkg, rule) => {
  const violations = sourceFiles()
    .filter((f) => importsPackage(read(f), rule.pkg))
    .map(rel)
    .filter((p) => !rule.allowedPrefixes.some((prefix) => p.startsWith(prefix)));

  expect(
    violations,
    `${rule.pkg} may only be imported from ${rule.allowedPrefixes.join(' or ')} — ${rule.why}`,
  ).toEqual([]);
});

test('instrumentation.ts uses ai ONLY for registerTelemetry', () => {
  // Narrows the exception above from "this file may import ai" to "this file may import exactly
  // one thing from ai" — otherwise the exception quietly becomes a second model call site.
  const file = join(ROOT, 'server', 'obs', 'instrumentation.ts');
  if (!existsSync(file)) return;
  const imported = [...read(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*'ai'/g)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  expect(imported).toEqual(['registerTelemetry']);
});

test('the bench harness never loads TAC', () => {
  // This is the runtime proof that runTurn is channel-agnostic. A static check on the import
  // string is weaker than the bench itself, but it fails faster and names the reason.
  const bench = join(ROOT, 'server', 'http', 'routes-bench.ts');
  if (!existsSync(bench)) return; // lands at T11
  const src = read(bench);
  expect(importsPackage(src, 'twilio-agent-connect')).toBe(false);
  expect(importsPackage(src, 'twilio')).toBe(false);
});

test('no console.* in server/ or web/src/', () => {
  // Every log line must go through the one pino instance, which carries the PII-scrubbing
  // logMethod hook. console.* bypasses it silently.
  const offenders = sourceFiles()
    .filter((f) => /(^|[^.\w])console\.(log|info|warn|error|debug|trace)\s*\(/.test(read(f)))
    .map(rel);
  expect(offenders, 'use the injected logger, not console.* (scripts/ is exempt)').toEqual([]);
});

test('every TAC path prefix appears in the Traefik router labels', async () => {
  // The two containers share one public host, split by path. Adding a TAC route and
  // forgetting its PathPrefix() produces a 404 that looks like a Twilio problem — so the
  // compose file is asserted against shared/twilio-paths.ts rather than trusted.
  const compose = join(ROOT, 'docker-compose.yml');
  if (!existsSync(compose)) return; // lands at T15
  const yaml = read(compose);
  const { TAC_WEBHOOK_PATHS, APP_API_PATHS } = await import('../shared/twilio-paths.ts');

  const missing = [...TAC_WEBHOOK_PATHS, ...APP_API_PATHS].filter(
    (p) => !yaml.includes(`PathPrefix(\`${p}\`)`),
  );
  expect(missing, 'add these to the router rules in docker-compose.yml').toEqual([]);

  // The X-Forwarded-Proto override is what stops TAC rebuilding the signed URL as http://
  // and 403-ing every single webhook. Losing this label is a silent, total outage.
  expect(
    /customrequestheaders\.X-Forwarded-Proto\s*=\s*https/.test(yaml),
    'the X-Forwarded-Proto=https middleware label is required or every webhook 403s',
  ).toBe(true);
});

test('shared/ imports nothing outside shared/', () => {
  // shared/ is compiled by BOTH tsconfig projects. A dependency on anything else breaks one
  // side or the other, and the break is a type error a long way from the cause.
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'shared'))) {
    const src = read(file);
    for (const match of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec === undefined) continue; // noUncheckedIndexedAccess: capture groups are optional
      const isRelativeWithinShared = spec.startsWith('./') || spec.startsWith('../');
      if (!isRelativeWithinShared) offenders.push(`${rel(file)} -> ${spec}`);
      else if (spec.includes('../../')) offenders.push(`${rel(file)} -> ${spec} (escapes shared/)`);
    }
  }
  expect(offenders, 'shared/ must be self-contained data + pure constants').toEqual([]);
});
