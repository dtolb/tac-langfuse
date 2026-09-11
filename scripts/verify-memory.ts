/**
 * Diagnostic: is Conversation Memory ACTUALLY on, and has extraction ever produced anything?
 *
 *   node --env-file-if-exists=.env scripts/verify-memory.ts
 *
 * This exists because memory is the feature in this repo most able to look wired and do nothing.
 * `capabilities().memory` is true as soon as a Conversation Orchestrator configuration id is present
 * — which is correct, because Recall genuinely works then — but **extraction is a separate switch on
 * the configuration**, and with it off the store stays empty forever. Every turn then composes an
 * empty memory block, the agent answers perfectly well from history and tools, and nothing anywhere
 * says the headline feature is inert. No `/health` field can honestly report this: the answer lives
 * in the Twilio account, not in the process.
 *
 * So this is the answer to "is memory on?", and it CHECKS rather than prints — every surprise sets
 * `process.exitCode = 1`, like the other five `verify-*` scripts.
 *
 * ── Two things it reports that are easy to get wrong ─────────────────────────────────────────────
 *
 * **Extraction is POST-conversation only.** There is no mid-conversation extraction: observations are
 * written on an INACTIVE/CLOSED transition, asynchronously, by Orchestrator. So an empty store on a
 * freshly flipped configuration is the EXPECTED state, not a failure — it means no conversation has
 * closed yet. That is why an empty store is reported as a baseline rather than a FAIL, and why the
 * real proof needs two conversations with a close between them.
 *
 * **`VOICE.captureRules` must stay empty.** Voice reaches Orchestrator through the
 * `conversationConfiguration` attribute on the `<ConversationRelay>` noun — active-TwiML ingestion —
 * and Twilio's own docs warn that adding voice capture rules on top of that bills STT twice, once
 * through ConversationRelay and once through the Real-Time Transcription stream the rule creates.
 * Measured on this account: the scaffold configuration has held voice transcripts as
 * `TRANSCRIPTION` communications since T13 with capture rules empty from birth. A non-empty array
 * here is therefore a real, billable regression, so it is a FAIL rather than a note.
 *
 * ── Measured on the first run, 2026-09-11, immediately after flipping the flag ───────────────────
 *
 *   memoryExtractionEnabled  false -> true   (PUT returned 202 + a statusUrl; see below)
 *   memoryStoreId            set, and the store answers
 *   intelligenceConfigurationIds  []         <- the open question, see the note this prints
 *   profiles                 1
 *   traits                   { Contact: { phone: "+1***1146" } }
 *   observations             null            <- not [], and that distinction matters, see below
 *
 * **The PUT is asynchronous.** Updating a configuration returns **202** with a `statusUrl`, not 200
 * with the new body — the same shape documented for configuration and memory-store *creates*, which
 * is easy to assume applies only to creates. Poll it to `COMPLETED` before trusting the change, and
 * re-GET to confirm nothing else moved: it is a full-replace PUT, so an omitted mutable field is
 * deleted.
 *
 * **An empty observation list comes back as `null`, not `[]`.** TAC's own `parseItems` coerces a
 * non-array to `[]` but logs a warning while doing it, so until the first extraction lands there may
 * be one such warning per turn. Expected, not a bug. `/Summaries` is NOT a listable subresource — it
 * 404s — so summaries are only observable through Recall, which is why this script counts
 * observations only.
 */
import { capabilities, loadConfig } from '../server/config.ts';

/** Records a surprise and keeps going, so one run reports every problem rather than the first. */
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

const CONFIG_BASE = 'https://conversations.twilio.com/v2/ControlPlane/Configurations';
const MEMORY_BASE = 'https://memory.twilio.com/v1/Stores';

/** Last 4 digits only. This script prints account data to a terminal and a phone number is PII. */
const maskPhone = (s: string): string => (s.length <= 4 ? '***' : `+1***${s.slice(-4)}`);

const config = loadConfig(process.env);
const caps = capabilities(config);

console.log('memory wiring\n');

if (config.twilio === null) {
  fail('no Twilio credentials — set TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET');
  console.log(`\n${failures} check(s) FAILED (exit 1)`);
  process.exitCode = 1;
} else if (config.conversationConfigurationId === null) {
  fail(
    'TWILIO_CONVERSATION_CONFIGURATION_ID is unset, so there is no Conversation Orchestrator ' +
      'configuration to read — Memory, Knowledge and handoff are all absent without it',
  );
  console.log(`\n${failures} check(s) FAILED (exit 1)`);
  process.exitCode = 1;
} else {
  const auth = `Basic ${Buffer.from(`${config.twilio.apiKey}:${config.twilio.apiSecret}`).toString('base64')}`;
  const get = async (url: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(url, { headers: { authorization: auth } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  console.log(`  capabilities: memory=${caps.memory} knowledge=${caps.knowledge} sms=${caps.sms} voice=${caps.voice}`);
  console.log(`  configuration: ${config.conversationConfigurationId}`);

  // ---- the configuration: the switch, the store, and the two things not to break ----
  const cfg = await get(`${CONFIG_BASE}/${config.conversationConfigurationId}`);
  if (cfg.status !== 200) {
    fail(`GET configuration returned ${cfg.status} — cannot tell whether extraction is on`);
  } else {
    const c = cfg.body as Record<string, unknown>;
    const extraction = c['memoryExtractionEnabled'];
    const storeId = typeof c['memoryStoreId'] === 'string' ? c['memoryStoreId'] : null;
    const intel = Array.isArray(c['intelligenceConfigurationIds']) ? c['intelligenceConfigurationIds'] : [];
    const channels = (c['channelSettings'] ?? {}) as Record<string, { captureRules?: unknown[]; statusTimeouts?: Record<string, unknown> | null }>;

    console.log(`  version: ${String(c['version'])}   updatedAt: ${String(c['updatedAt'])}`);

    if (extraction !== true) {
      fail(
        'memoryExtractionEnabled is not true — Orchestrator will never write an observation, so ' +
          'Recall returns nothing forever and the memory block is empty on every turn',
      );
    } else {
      console.log('  memoryExtractionEnabled: true');
    }

    if (storeId === null) {
      fail('no memoryStoreId on the configuration — Recall has nowhere to read from');
    }

    // The open question this account raises. NOT a failure: Twilio's documented truth table names
    // only memoryExtractionEnabled + memoryStoreId. But the one configuration on this account that
    // actually holds observations also has this populated, and every one of its observations carries
    // an `intelligence_operatorresult_*` source. So if extraction stays empty after a conversation
    // has genuinely closed, THIS is the next lever to try — not capture rules.
    if (intel.length === 0) {
      console.log(
        '  note: intelligenceConfigurationIds is empty. Documented as unnecessary, but the ' +
          'reference configuration on this account has one and its observations are sourced from ' +
          'it. If extraction produces nothing after a close, attach one before changing anything else.',
      );
    }

    // A billable regression, hence FAIL. See the header.
    const voiceRules = channels['VOICE']?.captureRules ?? [];
    if (voiceRules.length > 0) {
      fail(
        `channelSettings.VOICE.captureRules has ${voiceRules.length} entr${voiceRules.length === 1 ? 'y' : 'ies'} — ` +
          'voice reaches Orchestrator through the conversationConfiguration attribute on the ' +
          '<ConversationRelay> noun, so a capture rule bills STT a SECOND time on every call. Remove them.',
      );
    } else {
      console.log('  VOICE.captureRules: [] (correct — active-TwiML ingestion, no double-billed STT)');
    }

    // Extraction fires on an INACTIVE or CLOSED transition. `closed` is what the scaffold relies on;
    // report both, because a configuration with neither set can never extract at all.
    const smsTimeouts = channels['SMS']?.statusTimeouts ?? null;
    const closed = smsTimeouts?.['closed'] ?? null;
    const inactive = smsTimeouts?.['inactive'] ?? null;
    console.log(`  SMS statusTimeouts: closed=${JSON.stringify(closed)} inactive=${JSON.stringify(inactive)}`);
    if (closed === null && inactive === null) {
      fail(
        'SMS has neither a closed nor an inactive timeout, so no conversation ever transitions — ' +
          'extraction is triggered by that transition and would never fire',
      );
    } else if (inactive === null) {
      console.log(
        '  note: inactive is null, so only the CLOSED transition can trigger extraction. If ' +
          'nothing extracts after a close, setting an inactive timeout is the second lever.',
      );
    }

    // ---- the store: the baseline, and the thing the two-conversation proof compares against ----
    if (storeId !== null) {
      console.log(`\n  store: ${storeId}`);
      const profiles = await get(`${MEMORY_BASE}/${storeId}/Profiles`);
      if (profiles.status !== 200) {
        fail(`GET profiles returned ${profiles.status} — the store id may not match a real store`);
      } else {
        // The payload is a list of profile ID STRINGS, not objects — each has to be fetched.
        const ids = ((profiles.body as { profiles?: unknown }).profiles ?? []) as unknown[];
        console.log(`  profiles: ${ids.length}`);

        let totalObservations = 0;
        for (const raw of ids) {
          if (typeof raw !== 'string') continue;
          const [profile, obs] = await Promise.all([
            get(`${MEMORY_BASE}/${storeId}/Profiles/${raw}`),
            get(`${MEMORY_BASE}/${storeId}/Profiles/${raw}/Observations`),
          ]);

          // Traits are a nested object keyed by trait GROUP (e.g. `Contact`), not a flat list —
          // which is what TWILIO_MEMORY_PROFILE_TRAIT_GROUPS selects between.
          const traits = (profile.body as { traits?: Record<string, Record<string, unknown>> }).traits ?? {};
          const groups = Object.keys(traits);
          const rendered = groups
            .map((g) => {
              const fields = Object.entries(traits[g] ?? {}).map(([k, v]) => {
                const value = typeof v === 'string' && /^\+?\d{7,}$/.test(v) ? maskPhone(v) : String(v);
                return `${k}=${value}`;
              });
              return `${g}(${fields.join(' ')})`;
            })
            .join(' ');

          // `null`, not `[]`, when there are none. See the header.
          const list = (obs.body as { observations?: unknown }).observations;
          const count = Array.isArray(list) ? list.length : 0;
          totalObservations += count;

          console.log(`    ${raw}`);
          console.log(`      traits: ${rendered || '(none)'}`);
          console.log(`      observations: ${count}${Array.isArray(list) ? '' : ' (returned null, not [])'}`);
        }

        console.log('');
        if (totalObservations === 0) {
          // Deliberately NOT a failure. See the header: on a freshly flipped configuration this is
          // the expected state, because nothing has closed yet.
          console.log(
            '  BASELINE: no observations anywhere in this store yet.\n' +
              '  Expected right after enabling extraction — it runs post-conversation, never mid-conversation.\n' +
              '  To produce one: hold a real conversation, let it reach CLOSED, then re-run this script.\n' +
              '  Memory is proven only when a SECOND conversation, on a NEW conversationId, recalls a\n' +
              '  fact from the first — a fresh id means history.ts is empty, so nothing else could supply it.',
          );
        } else {
          console.log(`  ${totalObservations} observation(s) in the store — extraction HAS run on this account.`);
        }
      }
    }
  }

  console.log(
    failures === 0
      ? '\nall checks passed'
      : `\n${failures} check(s) FAILED — see the FAIL lines above (exit 1)`,
  );
  if (failures > 0) process.exitCode = 1;
}
