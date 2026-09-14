/**
 * The names of the tools this codebase adapts out of TAC — i.e. the ones that need a live TAC handle
 * to exist at all.
 *
 * Two adapters, not one, since T14b.1 appended index 2:
 *
 *  - indices 0 and 1 (`retrieve_profile_memory`, `search_knowledge`) → `server/twilio/builtin-tools.ts`
 *  - index 2 (`handoff`) → `server/twilio/handoff.ts`, added by T14b.2. It is built by
 *    `server/twilio/tac.ts` rather than by `adaptBuiltInTools`, because it needs the voice CHANNEL and
 *    not just a `TAC` handle.
 *
 * ── Why these names live in `shared/` rather than beside the tools ──────────────────────────────
 *
 * Two places need to agree about them and neither may import the other:
 *
 *  - `server/twilio/builtin-tools.ts` names the tools (and `server/twilio/handoff.ts` names index 2).
 *    Both import `twilio-agent-connect`, so nothing in `server/agent/` is allowed to import either
 *    (`tests/architecture.test.ts`).
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
 * by `ToolDef.requires` against `capabilities()`, and each of the three answers to a different
 * capability (`server/config.ts`):
 *
 *  - `retrieve_profile_memory` → `memory`, i.e. orchestrated mode.
 *  - `search_knowledge` → `knowledge`, i.e. orchestrated mode AND `TWILIO_KNOWLEDGE_BASE_ID`.
 *  - `handoff` → `handoff`, i.e. orchestrated mode AND a VALID `TWILIO_STUDIO_HANDOFF_FLOW_SID`. Valid
 *    matters: TAC's regex is `/^FW[0-9a-f]{32}$/`, so an uppercase-hex SID is treated as unconfigured
 *    rather than passed through to throw at construction.
 *
 * This is only the answer to "is this string a tool this codebase knows how to build at all, given the
 * right credentials?"
 *
 * ── What guards the list ───────────────────────────────────────────────────────────────────────
 *
 * A name here that no longer matches a real adapter makes the boot preflight in
 * `server/agent/tools/resolve.ts` silently forgive a real typo: `isTacToolName(name)` sends the name to
 * the `unavailable` bucket (one debug line) instead of `unknown` (one warning per turn). So the list
 * wants pinning from both sides, and the two adapters are pinned by two different suites:
 *
 *  - Indices 0 and 1 belong to `tests/builtin-tools.test.ts`. It does NOT read this list — it hard-codes
 *    `expect(tools.map((t) => t.name)).toEqual(['retrieve_profile_memory', 'search_knowledge'])` (~:267)
 *    plus the matching `requires`, and separately asserts that `handoff` is NOT among the adapted tools.
 *    That is correct now that this list is a strict SUPERSET of what `builtin-tools.ts` adapts;
 *    asserting the whole list there would go red on every append.
 *  - The list itself, and index 2, belong to `tests/tools.test.ts`: the positional assertions (~:287-290)
 *    and the preflight tests, which derive their expectations from the compiled DEFAULTS rather than
 *    from this list for the same superset reason.
 *
 * Every name in the list now has an adapter behind it, so `unavailable` means what it says again — "this
 * codebase can build it, given the credentials". That was NOT true between T14b.1 and T14b.2:
 * `isTacToolName('handoff')` was already true while no adapter existed, so a prompt naming `handoff`
 * was bucketed `unavailable` and logged at debug, indistinguishable from a tool that was merely
 * unconfigured. The gap was deliberate — index 2 had to exist before the code that reads it by position
 * could be written — and any future append reopens it for exactly as long as its adapter is missing.
 *
 * ⚠ APPEND ONLY. `server/twilio/builtin-tools.ts` reads index 0 and index 1 by position, and
 * `server/twilio/handoff.ts` reads index 2. Inserting a name renames live tools silently, which a
 * prompt naming the old string then reports only as one `unknown` warning per turn.
 */
export const TAC_TOOL_NAMES = ['retrieve_profile_memory', 'search_knowledge', 'handoff'] as const;

export type TacToolName = (typeof TAC_TOOL_NAMES)[number];

export const isTacToolName = (name: string): name is TacToolName =>
  (TAC_TOOL_NAMES as readonly string[]).includes(name);
