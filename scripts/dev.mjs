// @ts-check
// Runs the agent and the web app together:  pnpm dev:all
//
// Hand-rolled rather than `concurrently` or `a & b`, for one measured reason: `&` orphans the
// child on Ctrl-C, and an orphan still holding port 3000 or 8910 makes the NEXT start fail
// with a confusing EADDRINUSE that looks unrelated to the Ctrl-C you just pressed.
//
// Deliberately zero-dependency and deliberately outside both tsconfig projects (hence .mjs
// with @ts-check), so it can never be the reason a typecheck fails.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

/**
 * Resolve a package's bin by reading its package.json rather than import.meta.resolve —
 * modern packages' `exports` maps make resolving a bin path throw ERR_PACKAGE_PATH_NOT_EXPORTED.
 * @param {string} pkgDir absolute path to the package's install root
 * @param {string} pkgName
 * @param {string} binName
 * @returns {string}
 */
function resolveBin(pkgDir, pkgName, binName) {
  const pkgJsonPath = join(pkgDir, 'node_modules', pkgName, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
  if (!bin) throw new Error(`no bin "${binName}" in ${pkgName}`);
  return join(pkgDir, 'node_modules', pkgName, bin);
}

/**
 * @param {string} label
 * @param {string[]} args argv for process.execPath
 * @param {string} cwd
 * @param {boolean} detached own process group, so signals reach grandchildren
 */
function start(label, args, cwd, detached) {
  // process.execPath, not 'node' — respects the exact runtime running this script (volta,
  // nvm, a container's node) instead of whatever PATH happens to resolve.
  const child = spawn(process.execPath, args, {
    cwd,
    detached,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${label} exited (code=${code} signal=${signal}) — shutting down the rest`);
    shutdown('child-exit');
  });
  children.push(child);
  return child;
}

/** @param {string} reason */
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\n[dev] stopping (${reason})`);
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      // Negative pid signals the whole process group, which is what reaches the
      // `node --watch` grandchild. Without it the watcher survives and holds the port.
      if (child.pid > 1) process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  // Grace, then force. 300ms is enough for Fastify's close() and Next's teardown.
  setTimeout(() => {
    for (const child of children) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        if (child.pid > 1) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  }, 300).unref();
}

for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'])) {
  process.on(sig, () => shutdown(sig));
}
process.on('uncaughtException', (err) => {
  console.error('[dev] uncaught', err);
  shutdown('uncaughtException');
});

console.error('[dev] agent  -> http://localhost:8910/health');
console.error('[dev] web    -> http://localhost:3000');
console.error('[dev] ctrl-c stops both\n');

// The agent: Node 24 runs the TypeScript directly, no build step.
start(
  'agent',
  ['--import', './server/obs/instrumentation.ts', '--env-file-if-exists=.env', '--watch', 'server/index.ts'],
  REPO_ROOT,
  true, // own group, so SIGTERM reaches the --watch grandchild
);

// Next dev. Left in the foreground process group so its TTY output behaves.
const webDir = join(REPO_ROOT, 'web');
start('web', [resolveBin(webDir, 'next', 'next'), 'dev'], webDir, false);
