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

/** Tolerates `{{ persona }}` as well as `{{persona}}`; Langfuse's editor emits both. */
const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const isSlotName = (name: string): name is SlotName =>
  (SLOT_NAMES as readonly string[]).includes(name);

const fill = (content: string, slots: Slots): string =>
  // A replacer FUNCTION rather than a string, so a `$&` inside a slot value is inserted
  // literally instead of being interpreted as a backreference.
  content.replace(PLACEHOLDER_RE, (_match, name: string) => {
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
