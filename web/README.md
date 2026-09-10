# web — the Next.js front end

Next.js 16 (App Router) + `@gtmi/strix-react`. This is one of the scaffold's two containers; the
agent (Fastify + TAC + our API + SSE) is the other and lives at the repo root.

Start here instead of this file: [`../docs/HANDOFF.md`](../docs/HANDOFF.md) for current status and
architecture. The full README lands at T20.

## Running it

From the **repo root**, not from here:

```bash
pnpm dev:all     # agent :8910 + web :3000, ctrl-c stops both
pnpm dev:web     # web only
pnpm status      # what's running, what's configured, what's therefore possible
```

Pages: `/` is a placeholder until T18. **`/bench` is the live one** — type a message and a real turn
streams back.

`next.config.ts` rewrites `/api`, `/events` and `/health` to the agent **in development only**. That
is what lets browser code fetch RELATIVE paths, which is what production needs: Traefik path-splits
those prefixes to the agent container on the same public host. Do not reintroduce an agent origin in
client code — it would need CORS (a JSON POST is preflighted, so it fails on the OPTIONS) and would
leave two code paths to keep in step. Verified that the rewrite streams rather than buffers; a
buffering proxy is indistinguishable from a slow model.

`web/` has its own `package.json`, its own lockfile and its own `.npmrc` — Next insists on owning its
project root, and this matches the two-container deploy. So a front-end dependency is added with
`pnpm --dir web add …`, not at the root.

## Four things not to change

1. **`src/app/globals.css` is exactly three lines**, and the import order is load-bearing — it fails
   *silently* if reversed:
   ```css
   @import 'tailwindcss';
   @import '@gtmi/strix-react/tokens.css';
   :root, [data-theme='dark'] { color-scheme: dark; }
   ```
   Do not copy Strix's own `apps/demo/globals.css`. Its `source(none)` / `@source '../'` trick is
   specific to that test harness — its header says so — and copying it stops Tailwind detecting
   `web/src/**`.
2. **No `next/font`.** Strix ships Whitney SSm and declares all three font tokens itself. The
   generated Geist wiring was removed deliberately: Next's `@theme inline` block overwrote Strix's
   font tokens, and its light `--background`/`--foreground` plus `prefers-color-scheme` block are
   meaningless for a dark-only design system.
3. **Never add** tsconfig `paths` for `@gtmi/strix-react/*`, `transpilePackages`, a custom PostCSS
   plugin, or your own `@source`. All four are 0.0.1-era workarounds that now cause harm — the first
   makes every Strix import `undefined` at runtime. The generated `postcss.config.mjs`
   (`{ plugins: ['@tailwindcss/postcss'] }`) is already correct.
4. **`allowImportingTsExtensions: true`** in `tsconfig.json` is required. `shared/` is compiled by
   both tsconfig projects and the node side needs `.ts` extensions on imports; Turbopack resolves
   them fine at runtime (verified, not assumed).

## Strix, accurately

The authoritative component list is the `exports` map in
`node_modules/@gtmi/strix-react/package.json` — **not `llms.txt`**, which is stale. Per-component
props are in the shipped `*.manifest.json` files, where `props` is an **array** of
`{name, type, required, default, description}`, not an object keyed by name.

There is **no** Table, Chart, Drawer, Accordion, Popover or EmptyState, and Toast/Alert are
presentational with no queue or provider. Plan around that rather than discovering it mid-build:
a timeline becomes `ConsoleMessage` + `ToolCall` rows, a detail drawer becomes a `Dialog`, metrics
become `MetricList`, and a toast queue is ours to write.

`Typography` has no `heading-*` variants — the axes are `h1`–`h7`, `d1`–`d7`, `body-{l,m,s,xs}`,
`subhead-*`, `eyebrow-*`, `mono-*`, `cta-*`. Use `<Typography variant="h2" as="h1">` to separate look
from semantics. The weight suffixes are **not** uniform across the body scale: `body-m-regular` exists
but **`body-s-regular` and `body-xs-regular` do not** — those are plain `body-s` and `body-xs`. Read
the `variant` union in the manifest rather than extrapolating from a sibling. (Type error, so `tsc`
catches this one.)

**Several components carry no layout padding and accept no `className`.** `ChatLog` is the one that
bit: its root is `flex flex-col gap-gap-400 min-h-0 w-full overflow-y-auto`, with nothing horizontal,
and a `side: 'end'` message is a `flex-row-reverse` row whose author is `shrink-0 min-w-14`. Dropped
straight into a bordered box, the author label of every one of the reader's own messages is clipped —
"You" renders as "Yo". Since there is no `className` prop, the padding belongs on your wrapper. This
was invisible in the accessibility snapshot and in every assertion, and obvious in a screenshot; take
one before believing a Strix layout is right.

`ChatLog` does have a built-in empty state (`emptyTitle` / `emptyBody` / `emptyState`) even though
Strix exports no `EmptyState` component. Its `custom` entry type is the escape hatch for anything that
should sit in the transcript flow without a banner's weight — an `event` entry is a full-width filled
bar, which is right for something the reader must not miss and far too loud for a per-turn footnote.

Token names that look obvious may not exist: `surface-base`, `text-primary`, `text-secondary` and
`surface-neutral-soft` are real; `border-default` is **not**, despite being the obvious guess, and a
wrong token name generates no CSS and reports nothing. Grep
`node_modules/@gtmi/strix-react/src/tokens/theme.css` before trusting one. Real border tokens are
shaped `border-accent`, `border-card-card-primary`, `border-button-outline`.

`card` and `button` are ambiguous subpaths (`./atoms/*` vs `./icons/*`) — always import the full path.

## AGENTS.md / CLAUDE.md

Both are generated by `create-next-app` and re-added by `next dev`, so they are committed rather than
deleted — removing them from a diff only recreates an uncommitted change. `AGENTS.md` usefully points
at `node_modules/next/dist/docs/`, which is worth reading: this Next is newer than most training data.
