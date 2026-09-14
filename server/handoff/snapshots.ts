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
