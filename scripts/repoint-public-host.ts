/**
 * Repoint every place the public host is baked in, in one command.
 *
 *   node --env-file-if-exists=.env scripts/repoint-public-host.ts <host>          # dry run
 *   node --env-file-if-exists=.env scripts/repoint-public-host.ts <host> --write  # do it
 *
 * `<host>` is a BARE HOST, no scheme and no trailing slash — `abc123.ngrok-free.app`. That is the
 * shape `TWILIO_VOICE_PUBLIC_DOMAIN` takes, because TAC builds `wss://${domain}${path}` from it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * Until T15 gives this app a stable Traefik host, the public URL lives in THREE places that must
 * agree, and nothing checks that they do:
 *
 *   1. `TWILIO_VOICE_PUBLIC_DOMAIN` in `.env`      — read at boot; TAC throws without it and builds
 *                                                     the `wss://` URL and the `<Connect action>` from it
 *   2. the phone number's `voice_url`               — where Twilio fetches TwiML on an inbound call
 *   3. the Conversation Orchestrator configuration's `statusCallbacks[0].url` — how INBOUND SMS
 *                                                     reaches us at all (not the number's `sms_url`)
 *
 * Miss (1) and voice boots against a dead host. Miss (2) and calls never arrive. Miss (3) and texts
 * never arrive, silently — nothing appears on the obs bus, which reads as a code bug rather than a
 * stale URL. Doing this by hand was measured to take three separate API shapes and a full-replace PUT.
 *
 * ── The one genuinely dangerous step ────────────────────────────────────────────────────────────
 *
 * Updating the CO configuration is a **full-replace PUT**: every mutable field omitted from the body
 * is DELETED. So this script GETs the whole configuration, writes it to `.superpowers/t14/` verbatim,
 * RE-READS that file and checks it parses and still carries every key it started with, and only then
 * sends a body derived from it with exactly one URL changed. A truncated backup is worse than none,
 * because it reads as recoverable right up until it is needed — hence the re-read rather than trusting
 * the write. Recovery is PUTting the saved file back unchanged.
 *
 * It then re-GETs and DIFFS against the backup, failing loudly if anything other than
 * `statusCallbacks`, `updatedAt` and `version` moved. Measured 2026-09-14: a correct run changes
 * exactly those three and loses no keys.
 *
 * Two Twilio API shapes worth knowing, both measured rather than assumed:
 *   - the CO configuration PUT is **ASYNCHRONOUS**: it returns 202 with a `statusUrl` to poll to
 *     COMPLETED, not 200 with the new body. Anything that assumes 200 proceeds on a change that has
 *     not landed. (This is documented for CREATES; it is true of updates too.)
 *   - the phone-number update is an ordinary synchronous form POST returning 200.
 *
 * ── What it deliberately does NOT touch ─────────────────────────────────────────────────────────
 *
 * `sms_url` on the number stays empty. Inbound SMS arrives through the CO `statusCallbacks` plus the
 * bidirectional `channelSettings.SMS.captureRules`, NOT through the number's own webhook — proven at
 * T12. Setting it would add a second, competing inbound path.
 *
 * `channelSettings.VOICE.captureRules` stays `[]`. Voice reaches Orchestrator through the
 * `conversationConfiguration` attribute on the `<ConversationRelay>` noun, and Twilio's own docs warn
 * that adding voice capture rules on top of that bills STT twice.
 *
 * Restart the agent afterwards: `.env` is read once, at boot.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BARE_HOST = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?$/i;
const BACKUP_DIR = '.superpowers/t14';
const CONFIG_BASE = 'https://conversations.twilio.com/v2/ControlPlane/Configurations';
/** Read-only on a full-replace PUT — sending them back is rejected or ignored. */
const READONLY_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'version']);
/** The only keys a correct repoint may change. Anything else means the PUT ate something. */
const EXPECTED_DIFF = new Set(['statusCallbacks', 'updatedAt', 'version']);

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

const host = process.argv[2];
const write = process.argv.includes('--write');

if (host === undefined || host.startsWith('-')) {
  console.log('usage: scripts/repoint-public-host.ts <bare-host> [--write]');
  process.exitCode = 1;
} else if (host.includes('://') || host.endsWith('/')) {
  console.log(`  FAIL  "${host}" must be a BARE host — no scheme, no trailing slash`);
  process.exitCode = 1;
} else if (!BARE_HOST.test(host)) {
  console.log(`  FAIL  "${host}" does not look like a host`);
  process.exitCode = 1;
} else {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const apiKey = process.env['TWILIO_API_KEY'];
  const apiSecret = process.env['TWILIO_API_SECRET'];
  const coId = process.env['TWILIO_CONVERSATION_CONFIGURATION_ID'];

  if (!accountSid || !apiKey || !apiSecret || !coId) {
    fail('need TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET and TWILIO_CONVERSATION_CONFIGURATION_ID');
    console.log(`\n${failures} check(s) FAILED (exit 1)`);
    process.exitCode = 1;
  } else {
    const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
    const json = async (url: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
      const res = await fetch(url, { ...init, headers: { authorization: auth, ...init?.headers } });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    };

    console.log(`repoint public host -> ${host}${write ? '' : '   (DRY RUN — pass --write to apply)'}\n`);

    // ---- 1. .env -------------------------------------------------------------------------------
    const envText = readFileSync('.env', 'utf8');
    const envLine = /^TWILIO_VOICE_PUBLIC_DOMAIN=.*$/m;
    const currentEnv = envText.match(envLine)?.[0]?.split('=')[1] ?? '(absent)';
    console.log(`  1. .env TWILIO_VOICE_PUBLIC_DOMAIN`);
    console.log(`     ${currentEnv} -> ${host}`);
    if (write) {
      if (!envLine.test(envText)) {
        fail('.env has no TWILIO_VOICE_PUBLIC_DOMAIN line to replace — add one and re-run');
      } else {
        // `.env` is gitignored and holds live credentials, so back it up beside the CO body rather
        // than editing in place with no way back.
        mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
        writeFileSync(`${BACKUP_DIR}/env-${stamp}.bak`, envText);
        writeFileSync('.env', envText.replace(envLine, `TWILIO_VOICE_PUBLIC_DOMAIN=${host}`));
        console.log(`     written (previous .env saved under ${BACKUP_DIR}/)`);
      }
    }

    // ---- 2. the phone number's voice_url -------------------------------------------------------
    const numbers = await json(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=50`,
    );
    const phoneNumber = process.env['TWILIO_PHONE_NUMBER'];
    const match = (numbers.body?.incoming_phone_numbers ?? []).find(
      (n: { phone_number?: string }) => n.phone_number === phoneNumber,
    );
    console.log(`\n  2. ${phoneNumber ?? '(TWILIO_PHONE_NUMBER unset)'} voice_url`);
    if (match === undefined) {
      fail(`no incoming phone number matching ${phoneNumber} on this account`);
    } else {
      console.log(`     ${match.voice_url || '(empty)'} -> https://${host}/twiml`);
      if (match.sms_url) {
        // Not fatal, but it means a second inbound path exists and this script did not create it.
        console.log(`     note: sms_url is ${JSON.stringify(match.sms_url)} — inbound SMS should arrive`);
        console.log(`           via the CO statusCallbacks instead, so this is worth a look`);
      }
      if (write) {
        const upd = await json(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${match.sid}.json`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ VoiceUrl: `https://${host}/twiml`, VoiceMethod: 'POST' }),
          },
        );
        if (upd.status !== 200) fail(`number update returned ${upd.status}`);
        else console.log(`     written (${upd.body?.voice_url})`);
      }
    }

    // ---- 3. the CO configuration's statusCallbacks ---------------------------------------------
    console.log(`\n  3. CO configuration statusCallbacks   ${coId}`);
    const before = await json(`${CONFIG_BASE}/${coId}`);
    if (before.status !== 200) {
      fail(`GET configuration returned ${before.status}`);
    } else {
      const cfg = before.body as Record<string, unknown>;
      const callbacks = (cfg['statusCallbacks'] ?? []) as { url?: string }[];
      console.log(`     ${callbacks[0]?.url ?? '(none)'} -> https://${host}/webhook`);
      console.log(`     version ${String(cfg['version'])}, extraction ${String(cfg['memoryExtractionEnabled'])}`);

      if (callbacks.length === 0) {
        fail('the configuration has NO statusCallbacks — inbound SMS has no route at all. Add one first.');
      } else if (write) {
        mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
        const backupPath = `${BACKUP_DIR}/co-config-${coId}-${stamp}.json`;
        const raw = JSON.stringify(cfg, null, 1);
        writeFileSync(backupPath, raw);

        // THE GUARD: re-read what was actually written, do not trust the write. A truncated backup
        // reads as recoverable right up until it is needed.
        const reread = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>;
        const missing = Object.keys(cfg).filter((k) => !(k in reread));
        if (missing.length > 0) {
          fail(`backup at ${backupPath} is missing ${missing.join(', ')} — refusing to PUT`);
        } else {
          console.log(`     backup verified: ${Object.keys(reread).length} keys, re-read and parsed`);
          console.log(`     recovery: PUT ${backupPath} back, unchanged`);

          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(cfg)) if (!READONLY_KEYS.has(k)) body[k] = v;
          body['statusCallbacks'] = callbacks.map((cb) => ({ ...cb, url: `https://${host}/webhook` }));

          const put = await json(`${CONFIG_BASE}/${coId}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          // 202 + statusUrl, NOT 200 + the new body. Measured; true of updates as well as creates.
          if (put.status !== 202 && put.status !== 200) {
            fail(`PUT returned ${put.status}: ${JSON.stringify(put.body).slice(0, 200)}`);
          } else {
            const statusUrl = put.body?.statusUrl as string | undefined;
            if (statusUrl !== undefined) {
              let status = 'PENDING';
              for (let i = 0; i < 10 && status !== 'COMPLETED'; i += 1) {
                const op = await json(statusUrl);
                status = String(op.body?.status ?? '?');
                if (status === 'FAILED' || status === 'ERROR') {
                  fail(`operation ${status}: ${JSON.stringify(op.body?.error)}`);
                  break;
                }
                if (status !== 'COMPLETED') await new Promise((r) => setTimeout(r, 2000));
              }
              console.log(`     operation ${status}`);
            }

            // Re-GET and diff, because a full-replace PUT is exactly the shape that eats a field.
            const after = await json(`${CONFIG_BASE}/${coId}`);
            const a = after.body as Record<string, unknown>;
            const changed = [...new Set([...Object.keys(cfg), ...Object.keys(a)])].filter(
              (k) => JSON.stringify(cfg[k]) !== JSON.stringify(a[k]),
            );
            const unexpected = changed.filter((k) => !EXPECTED_DIFF.has(k));
            const lost = Object.keys(cfg).filter((k) => !(k in a));
            console.log(`     changed: ${changed.join(', ')}`);
            if (unexpected.length > 0) fail(`the PUT also changed ${unexpected.join(', ')} — restore the backup`);
            if (lost.length > 0) fail(`the PUT DELETED ${lost.join(', ')} — restore the backup`);
            if (unexpected.length === 0 && lost.length === 0) console.log('     nothing else moved');
          }
        }
      }
    }

    console.log(
      failures === 0
        ? write
          ? '\nall three repointed. RESTART THE AGENT — .env is read once, at boot.'
          : '\ndry run OK — re-run with --write to apply'
        : `\n${failures} check(s) FAILED — see the FAIL lines above (exit 1)`,
    );
    if (failures > 0) process.exitCode = 1;
  }
}
