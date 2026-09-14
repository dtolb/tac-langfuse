/**
 * The names of the tools that `server/twilio/builtin-tools.ts` adapts out of TAC.
 *
 * ── Why these names live in `shared/` rather than beside the tools ──────────────────────────────
 *
 * Two places need to agree about them and neither may import the other:
 *
 *  - `server/twilio/builtin-tools.ts` names the tools. It imports `twilio-agent-connect`, so nothing
 *    in `server/agent/` is allowed to import it (`tests/architecture.test.ts`).
 *  - `server/agent/tools/resolve.ts`'s boot preflight has to tell a TYPO in a compiled prompt from a
 *    tool that exists but needs a TAC handle. Without this list it cannot, because the process-wide
 *    catalog it checks against holds only the credential-free tools.
 *
 * So the list is a pure constant, which is exactly what `shared/` is for. Importing it on both sides
 * means a rename cannot desynchronise them: change the string here and the tool, the preflight and the
 * test all move together.
 *
 * ── What this list is NOT ──────────────────────────────────────────────────────────────────────
 *
 * Not a catalog, and not a promise that these tools are available. Availability is decided at run time
 * by `ToolDef.requires` against `capabilities()` — `retrieve_profile_memory` needs orchestrated mode
 * and `search_knowledge` additionally needs `TWILIO_KNOWLEDGE_BASE_ID`. This is only the answer to
 * "is this string a tool this codebase knows how to build at all, given the right credentials?"
 *
 * A name here that no longer matches a real adapter would make the preflight silently forgive a real
 * typo, so `tests/builtin-tools.test.ts` asserts the adapted tools' names against this list.
 *
 * ⚠ APPEND ONLY. `server/twilio/builtin-tools.ts` reads index 0 and index 1 by position, and
 * `server/twilio/handoff.ts` reads index 2. Inserting a name renames live tools silently, which a
 * prompt naming the old string then reports only as one `unknown` warning per turn.
 */
export const TAC_TOOL_NAMES = ['retrieve_profile_memory', 'search_knowledge', 'handoff'] as const;

export type TacToolName = (typeof TAC_TOOL_NAMES)[number];

export const isTacToolName = (name: string): name is TacToolName =>
  (TAC_TOOL_NAMES as readonly string[]).includes(name);
