/**
 * `{{var}}` substitution against a tested allowlist.
 *
 * We do NOT use Langfuse's own `prompt.compile()`, which is otherwise right there. It resolves
 * what it recognises and leaves the rest as literal `{{typo}}` — and a typo'd slot name that
 * survives into the prompt produces a *worse agent that still passes every test*. That is the
 * most expensive class of bug in this codebase, because you only find it by reading transcripts
 * closely, and on a phone call `{{persona}}` is inaudible.
 *
 * So an unknown placeholder renders as a loud marker instead. Not a throw: taking the demo down
 * for a typo is worse than saying the typo out loud once, and the marker shows up in the Langfuse
 * trace and in the agent's own first reply, where somebody will notice it.
 *
 * Pure. No clock, no env, no I/O — `current_date` arrives as a value, because a model has no
 * clock and a global one would make this untestable.
 */
import type { PromptMessage } from './port.ts';

/** The four slots. Any other name is a typo by definition — that is the point of the list. */
export const SLOT_NAMES = ['persona', 'company_name', 'channel', 'current_date'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export type Slots = Partial<Record<SlotName, string>>;

/**
 * Everything between the braces that is not itself a brace — including whitespace, and including
 * nothing at all. Tolerating `{{ persona }}` as well as `{{persona}}` matters because Langfuse's
 * editor emits both, but the width is load-bearing for a second reason: a capture that excluded
 * whitespace (`[^{}\s]+`) did not match `{{company name}}`, `{{}}` or `{{ }}` at all, so those
 * passed through into the prompt VERBATIM. That is the failure this module exists to prevent —
 * `{{company name}}` reaches TTS and gets read aloud as braces, with no marker anywhere in the
 * trace. Matching them and rendering a marker is the whole point; the name is trimmed in `fill`.
 */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

const isSlotName = (name: string): name is SlotName =>
  (SLOT_NAMES as readonly string[]).includes(name);

const fill = (content: string, slots: Slots): string =>
  // A replacer FUNCTION rather than a string, so a `$&` inside a slot value is inserted
  // literally instead of being interpreted as a backreference.
  content.replace(PLACEHOLDER_RE, (_match, captured: string) => {
    // Trimmed here rather than in the pattern, so `{{ persona }}` still resolves while a name with
    // whitespace INSIDE it stays a miss — `{{company name}}` is a typo, not a slot.
    const name = captured.trim();
    // An empty name is the same class of bug as a misspelt one — a stray placeholder in the prompt
    // text — so it keeps the same marker word, and one search for `UNKNOWN SLOT` finds every kind.
    // `(empty)` rather than a blank, because `[[UNKNOWN SLOT: ]]` reads as a fault in the marker.
    if (name === '') return '[[UNKNOWN SLOT: (empty)]]';
    if (!isSlotName(name)) return `[[UNKNOWN SLOT: ${name}]]`;
    const value = slots[name];
    // Allowlisted but not supplied is a different bug from misspelt, and the two markers have to
    // be distinguishable: one is a prompt edit, the other is a call site that forgot an argument.
    return value === undefined ? `[[MISSING SLOT: ${name}]]` : value;
  });

/** New messages with every placeholder resolved. Does not mutate the input. */
export function compose(
  messages: readonly PromptMessage[],
  slots: Slots,
): readonly PromptMessage[] {
  return messages.map((message) => ({ role: message.role, content: fill(message.content, slots) }));
}
