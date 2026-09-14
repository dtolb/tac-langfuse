/**
 * The authored source of the Northwind Traders knowledge base: five support articles, pushed to
 * Twilio Enterprise Knowledge by `scripts/seed-knowledge.ts`.
 *
 * ── Why this lives in `scripts/` and not in `server/` ────────────────────────────────────────────
 *
 * The obvious parallel is `server/agent/prompt/defaults.ts`, which `scripts/seed-prompts.ts` pushes
 * to Langfuse. But that text is compiled into the server because the server READS it — it is the
 * fallback when Langfuse is unreachable. Nothing in the process ever reads these articles: the
 * agent gets them back out of Twilio through `search_knowledge`, as ranked chunks, over HTTP. Putting
 * prose the runtime never touches under `server/` would put it in the module graph
 * `tests/architecture.test.ts` polices and would imply a dependency that does not exist.
 *
 * So it sits beside every other artifact whose job is "run this deliberately against a live
 * account": the two seeders and the six `verify-*` diagnostics. `scripts/` is also already exempt
 * from the no-console rule and from the vendor boundary, which is what a seeder needs.
 *
 * ── Why these five topics and not others ────────────────────────────────────────────────────────
 *
 * The content must NOT overlap the two demo tools in `server/agent/tools/catalog.ts`. `lookup_order`
 * owns order status, line items and delivery estimates; `get_store_hours` owns opening hours. If a
 * knowledge article restated either, the model would have two plausible sources for one question and
 * tool selection would get worse rather than better — an ambiguous demo is a bad demo even when both
 * answers are correct.
 *
 * These five are what a customer actually asks that NEITHER tool can answer: returns, shipping
 * policy, warranty, damage and missing-item claims, price matching. Two of them carry a deliberate
 * one-line pointer BACK to order lookup (`shipping-times`, `damaged-missing`) at exactly the seam
 * where a reader would otherwise expect a per-order answer. That is ordinary support-article
 * practice, and here it doubles as a disambiguation hint the retriever can surface.
 *
 * ── What the API actually accepts, measured 2026-09-14 ──────────────────────────────────────────
 *
 * - `source.type` is `"Text"`, capitalised. The docs prose says "text"; the OpenAPI enum this repo
 *   can read lists only `"File"`. `"Text"` is what returned 201.
 * - `source.content` accepted 1500 characters on a probe. The Enterprise Knowledge *docs page*
 *   claims `<= 1024`; the API reference says 185000. The docs page is wrong — the longest article
 *   here is over 1024 and was indexed. Do not shorten an article to satisfy that number.
 * - `name` is capped at 30 characters and `description` at 1024, both enforced.
 *
 * One article per topic rather than one document, because the retriever returns CHUNKS and a chunk
 * that spans two policies is a chunk that answers neither cleanly. Each article is written with
 * headings and short sections so the chunk boundaries fall somewhere useful.
 */

export interface KnowledgeArticle {
  /** Max 30 chars, enforced by the API. Stable: the seeder matches on it to avoid duplicates. */
  readonly name: string;
  /** Max 1024 chars. "When to use this", which is context for the indexer and for a human in the Console. */
  readonly description: string;
  readonly content: string;
}

const RETURNS = `# Returns and exchanges at Northwind Traders

## The return window
Most Northwind Traders items can be returned within 30 days of delivery. The window runs from the day the parcel is delivered, not the day the order was placed. Items bought as gifts get 45 days.

## Condition we accept
We accept returns in any condition short of damage the customer caused, including opened boxes and assembled products. A standing desk mat that has been unrolled and used for a week is still returnable. Missing hardware does not void a return, though we note it on the refund.

## What cannot be returned
- Custom-cut cable tray lengths, because they are made to order.
- Replacement bulbs and lamp accessories once the seal is broken.
- Anything past 30 days, unless it qualifies as a warranty claim instead.

## How a return is started
Ada or a human agent opens a return authorization from the order number and emails a prepaid label within one business day. The customer never pays return shipping on a domestic return. International returns are paid by the customer and reimbursed once the item arrives at the warehouse.

## Refunds
Refunds go back to the original payment method within 3 to 5 business days of the warehouse scanning the return. Card issuers can add another 2 to 3 days on top of that. Store credit is issued immediately instead, and we add 10 percent to the value of any refund the customer takes as store credit.

## Exchanges
An exchange is processed as a return plus a new order, so the replacement ships right away instead of waiting for the original to come back. If the replacement costs more we charge the difference; if it costs less we refund it.`;

const SHIPPING = `# Shipping timeframes and costs

Northwind Traders ships from one warehouse. Business days exclude weekends and US federal holidays.

## Published transit times
- Standard ground: 3 to 5 business days. Free on orders over 75 dollars, otherwise 6.95.
- Expedited: 2 business days, 14.95 flat.
- Overnight: next business day when ordered before 1pm Central, 29.95 flat.
- Freight: standing desk mats in quantities above 10, and any order over 150 pounds, ship by freight carrier in 5 to 8 business days and are quoted per order.

## Order cutoff
Orders placed before 1pm Central on a business day are picked the same day. Anything later, or on a weekend, starts its transit count on the next business day.

## Split shipments and oversize items
Monitor arms, desk lamps and cable trays all ship in standard parcels. Standing desk mats ship rolled in a tube and will sometimes arrive a day behind the rest of a multi-item order. A split shipment is normal, not an error, and each parcel has its own tracking number.

## Where we ship
All 50 US states plus Canada. Alaska and Hawaii are standard ground only and add 2 to 3 business days. Canadian orders ship duty-paid, so the customer owes nothing at the border.

## One thing this article cannot tell you
These are the published policy times, not a promise about a particular parcel. For the current status or the delivery estimate on an order the customer has already placed, look that order up by its order number instead of quoting the ranges above.`;

const WARRANTY = `# Warranty terms

Every Northwind Traders product is warranted against defects in materials and workmanship, starting on the delivery date. The term differs by product.

- Monitor arm: 5 years. Covers the gas spring losing tension, a cracked desk clamp, and any failure of the VESA plate.
- Desk lamp: 2 years on the fixture and the driver, including the LED panel losing more than 30 percent of its brightness.
- Cable tray: 2 years on the tray and its mounting hardware. Adhesive mounting strips are consumable and are not covered.
- Standing desk mat: 1 year against foam that stops rebounding, delamination, and edge curl that does not flatten within 72 hours.

## What is covered
A defect is a failure of the product under normal use. We replace the item or the failed part at our cost, shipping both ways included. There is no deductible and no handling fee.

## What is not covered
Cosmetic wear, damage from a drop or a spill, damage from outdoor use, and any product that has been modified — a cable tray cut down with a saw, a monitor arm fitted with a third-party clamp. Commercial use in a shared office is covered. Use as rental or event equipment is not.

## Making a claim
The customer needs the order number and either a photo or a short description of the failure. Ada can open the claim directly. Original packaging is not required, and the warranty is not limited to the original purchaser — it transfers with the product, so a second-hand monitor arm still inside its 5 years is covered once we can see the original order date.

## Warranty versus return
A return is for an item the customer no longer wants and closes after 30 days. A warranty claim is for an item that failed and stays available for the full term. Past 30 days, a working item cannot be returned but a broken one can still be claimed.`;

const CLAIMS = `# Damaged, missing and wrong-item claims

## Report window
Report a damaged, missing or incorrect item within 14 days of delivery. After 14 days we handle it as a warranty claim where the product still qualifies.

## Damaged on arrival
Ask the customer to keep the packaging and photograph both the box and the item. We ship a replacement as soon as the claim is filed — we do not wait for the damaged item to come back and we never charge for the replacement up front. Most damaged items are not worth returning; when one is, the prepaid label travels with the replacement.

Crushed tubes are the most common damage report on standing desk mats. A mat with a crease that flattens within 72 hours is not damaged. A mat with a torn surface, or a fold still visible after 72 hours, is.

## Missing from a multi-item order
Confirm whether the order shipped as more than one parcel before treating anything as missing, because a split shipment is normal and each parcel tracks separately. If a parcel arrived and an item inside it is genuinely absent, we ship the missing item immediately. A second claim on the same order within 60 days goes to a supervisor before the replacement ships.

## Wrong item received
We send the correct item straight away with a prepaid label for the wrong one, and the customer does not wait for us to receive it first. If returning the wrong item would cost more than the item is worth, we tell the customer to keep or donate it.

## Marked delivered but not there
Ask the customer to check with anyone else at the address and look for a carrier note, then wait 24 hours — carriers scan parcels as delivered early far more often than they lose them. After 24 hours we file a carrier claim and ship a replacement the same day.

## What this article does not cover
Whether a specific order has shipped, and which parcel holds which item, come from an order lookup by order number, not from this policy.`;

const PRICE_MATCH = `# Price match guarantee

Northwind Traders matches a lower advertised price, before or after the purchase.

## Before buying
Show us the lower price on the competitor's own site and we match it at checkout. There is no form and no waiting period.

## After buying
If the price drops within 14 days of the order date — ours or a qualifying competitor's — we refund the difference to the original payment method. Those 14 days run from the order date, not from delivery.

## Which retailers qualify
Any US retailer that stocks the identical item, new, in the same quantity, and can ship it to the customer's address. Marketplace listings from third-party sellers do not qualify even on a large retailer's site, because we cannot verify that the item is new and identical.

## What does not qualify
- Auction, clearance, open-box, refurbished and liquidation prices.
- Prices that need a membership, a coupon code or a bundle purchase.
- Obvious typographical errors, and prices that were live for under 24 hours.
- Our own bundle pricing. A desk lamp bought inside a workspace bundle is matched against other bundles, not against a single-item price.

## Limits
One price match per item per customer per 30 days, up to a quantity of 5 of the same item. A price match cannot be stacked with a promotional discount on the same item — the customer keeps whichever of the two is worth more.`;

/**
 * The articles, in the order the seeder pushes them. Order is cosmetic: retrieval is semantic, so
 * nothing downstream depends on it.
 */
export const KNOWLEDGE_ARTICLES: readonly KnowledgeArticle[] = [
  {
    name: 'returns-and-exchanges',
    description:
      'Northwind Traders return window, accepted condition, non-returnable items, how a return authorization and prepaid label are issued, refund timing, and how an exchange is processed. Use for "can I send this back", refund timing, and exchange questions. Does not cover the status of an order.',
    content: RETURNS,
  },
  {
    name: 'shipping-times-and-costs',
    description:
      'Published shipping methods, transit times, costs, free-shipping threshold, order cutoff, split shipments, and the regions Northwind Traders ships to. Use for "how long does shipping take" and "how much is shipping" in general. For the delivery estimate on an order that already exists, look the order up instead.',
    content: SHIPPING,
  },
  {
    name: 'warranty-terms',
    description:
      'Warranty length and coverage per product — monitor arm, desk lamp, cable tray, standing desk mat — what counts as a defect, exclusions, how to open a claim, and how a warranty claim differs from a return. Use when a product has failed or a customer asks how long an item is guaranteed for.',
    content: WARRANTY,
  },
  {
    name: 'damaged-missing-claims',
    description:
      'How Northwind Traders handles items that arrive damaged, items missing from a parcel, wrong items shipped, and parcels marked delivered that the customer cannot find. Includes the 14-day report window and when a replacement ships. Use for damage and non-delivery, not for routine order status.',
    content: CLAIMS,
  },
  {
    name: 'price-match-guarantee',
    description:
      'Northwind Traders price match rules: matching before purchase, refunding a drop within 14 days of the order date, which retailers and prices qualify, exclusions, and per-customer limits. Use when a customer has found the same item cheaper elsewhere or the price fell after they bought.',
    content: PRICE_MATCH,
  },
];
