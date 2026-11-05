// Turning "what the user asked for" into a valid order line, and validating/pricing lines against the menu.
// Pure functions: no I/O. Option sets are handled generically from the menu's own metadata (required, min/max,
// per-option stock), so Up & Go flavours, sandwich breads and sizes all go through the same code.
import { FlexiError } from "./errors.ts";
import type { ItemRequest, Menu, MenuItem, MenuOption, MenuOptionSet, OrderLine, PlaceOrderBody, PlanLine } from "./types.ts";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const lc = (s: string): string => s.trim().toLowerCase();

/**
 * Parses a compact spec used by the CLI:  `Name [Option; Set=Option] x2`
 *   "Up & Go [Chocolate]"
 *   "Ham & Cheese Sandwich [Bread Options=GLUTEN FREE] x2"
 *   "Bacon, Tomato & Cheese Roll"
 */
export function parseItemSpec(spec: string): ItemRequest {
  const m = /^(.+?)(?:\s*\[([^\]]*)\])?(?:\s+x(\d+))?\s*$/.exec(spec);
  if (!m) throw new FlexiError("precondition", `Cannot parse item "${spec}"`);
  const choices = (m[2] ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const eq = t.indexOf("=");
      return eq < 0 ? { option: t } : { set: t.slice(0, eq).trim(), option: t.slice(eq + 1).trim() };
    });
  return { item: m[1]!.trim(), ...(m[3] ? { quantity: Number(m[3]) } : {}), ...(choices.length ? { choices } : {}) };
}

function pickOne<T>(candidates: T[], name: (t: T) => string, query: string): { hit?: T; many?: T[] } {
  const q = lc(query);
  const exact = candidates.filter((c) => lc(name(c)) === q);
  if (exact.length === 1) return { hit: exact[0]! };
  const pool = exact.length ? exact : candidates.filter((c) => lc(name(c)).includes(q));
  return pool.length === 1 ? { hit: pool[0]! } : { many: pool };
}

const optionLabel = (o: MenuOption): string => `${o.name}${o.price ? ` +$${o.price.toFixed(2)}` : ""}${o.inStock ? "" : " (sold out)"}`;

/** Finds a menu item by name. Sold-out items are reported as such, not silently skipped. */
export function findItem(menu: Menu, query: string): MenuItem {
  const { hit, many } = pickOne(menu.items, (i) => i.name, query);
  if (hit) {
    if (!hit.inStock) throw new FlexiError("precondition", `"${hit.name}" is not available on ${menu.date}`);
    return hit;
  }
  if (many && many.length > 1) {
    const avail = many.filter((i) => i.inStock);
    throw new FlexiError("not_found", `Ambiguous item "${query}": ${(avail.length ? avail : many).map((i) => i.name).join(", ")}`);
  }
  throw new FlexiError("not_found", `No item matching "${query}" on the ${menu.serviceName} menu for ${menu.date}`);
}

function findSet(item: MenuItem, query: string): MenuOptionSet {
  const { hit, many } = pickOne(item.optionSets, (s) => s.name, query);
  if (hit) return hit;
  throw new FlexiError("not_found", `${many?.length ? "Ambiguous" : "No"} option group "${query}" for "${item.name}". Groups: ${item.optionSets.map((s) => s.name).join(", ") || "(none)"}`);
}

function findOption(item: MenuItem, sets: MenuOptionSet[], query: string): { set: MenuOptionSet; option: MenuOption } {
  const all = sets.flatMap((set) => set.options.map((option) => ({ set, option })));
  const { hit, many } = pickOne(all, (x) => x.option.name, query);
  if (hit) return hit;
  if (many && many.length > 1) throw new FlexiError("not_found", `Ambiguous option "${query}" for "${item.name}": ${many.map((x) => `${x.set.name}=${x.option.name}`).join(", ")}`);
  throw new FlexiError(
    "not_found",
    `"${item.name}" has no option "${query}". ${sets.map((s) => `${s.name}: ${s.options.map(optionLabel).join(", ")}`).join("; ") || "It has no options."}`,
  );
}

/** Resolves a by-name request into keys. Does not enforce required/min/max: buildOrderItem does. */
export function resolveLine(menu: Menu, req: ItemRequest): OrderLine {
  const item = findItem(menu, req.item);
  const optionKeys: string[] = [];
  for (const c of req.choices ?? []) {
    const sets = c.set ? [findSet(item, c.set)] : item.optionSets;
    const { option } = findOption(item, sets, c.option);
    if (!optionKeys.includes(option.key)) optionKeys.push(option.key);
  }
  return { itemKey: item.key, quantity: req.quantity ?? 1, optionKeys };
}

export interface BuiltItem {
  line: PlanLine;
  body: PlaceOrderBody["placeOrderRequests"][number]["items"][number];
}

/** Validates one line against the menu (stock, required/min/max option sets) and prices it. */
export function buildOrderItem(menu: Menu, line: OrderLine): BuiltItem {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new FlexiError("precondition", "Quantity must be a positive integer");
  const item = menu.items.find((i) => i.key === line.itemKey);
  if (!item) throw new FlexiError("not_found", `Item ${line.itemKey} is not on the ${menu.serviceName} menu for ${menu.date}`);
  if (!item.inStock) throw new FlexiError("precondition", `"${item.name}" is not available on ${menu.date}`);
  if (item.hasQuestions) throw new FlexiError("precondition", `"${item.name}" asks questions at checkout; not supported yet`);

  const known = new Set(item.optionSets.flatMap((s) => s.options.map((o) => o.key)));
  const unknown = line.optionKeys.find((k) => !known.has(k));
  if (unknown) throw new FlexiError("precondition", `Option ${unknown} does not belong to "${item.name}"`);
  if (new Set(line.optionKeys).size !== line.optionKeys.length) throw new FlexiError("precondition", `Duplicate options for "${item.name}"`);

  const chosen: MenuOption[] = [];
  for (const set of item.optionSets) {
    const picked = set.options.filter((o) => line.optionKeys.includes(o.key));
    for (const o of picked) {
      if (!o.inStock) {
        const alt = set.options.filter((x) => x.inStock).map((x) => x.name);
        throw new FlexiError("precondition", `${set.name}: "${o.name}" is sold out${alt.length ? ` (available: ${alt.join(", ")})` : ""}`);
      }
    }
    if (picked.length < set.min) {
      throw new FlexiError("precondition", `"${item.name}" needs ${set.min === 1 ? "a choice" : `${set.min} choices`} for "${set.name}": ${set.options.filter((o) => o.inStock).map(optionLabel).join(", ")}`);
    }
    if (set.max > 0 && picked.length > set.max) {
      throw new FlexiError("precondition", `"${item.name}" allows at most ${set.max} for "${set.name}" (got ${picked.length})`);
    }
    chosen.push(...picked);
  }

  const unitPrice = round2(item.basePrice + chosen.reduce((sum, o) => sum + o.price, 0));
  return {
    line: { item: item.name, quantity: line.quantity, options: chosen.map((o) => o.name), unitPrice, lineTotal: round2(unitPrice * line.quantity) },
    body: {
      itemKey: item.key,
      quantity: line.quantity,
      options: chosen.map((o) => ({ optionKey: o.key, quantity: 1, isExcluded: false, isDefault: o.isDefault })),
      questions: [],
    },
  };
}
