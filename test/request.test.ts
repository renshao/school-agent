import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FlexiError } from "../src/flexischools/errors.ts";
import { normalizeMenu } from "../src/flexischools/normalize.ts";
import { buildOrderItem, findItem, parseItemSpec, resolveLine } from "../src/flexischools/request.ts";
import { ItemListResponse } from "../src/flexischools/schemas.ts";
import type { Menu, OrderLine } from "../src/flexischools/types.ts";
import { itemListResponse, K } from "./fixtures.ts";

const menu: Menu = normalizeMenu(ItemListResponse.parse(itemListResponse), "2026-11-06", K.supplier);
const rejectsWith = (fn: () => unknown, re: RegExp, kind?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof FlexiError && re.test(e.message) && (kind ? e.kind === kind : true), String(re));

describe("parseItemSpec", () => {
  it("plain name, with commas and ampersands", () => {
    assert.deepEqual(parseItemSpec("Bacon, Tomato & Cheese Roll"), { item: "Bacon, Tomato & Cheese Roll" });
  });
  it("bare option in brackets", () => {
    assert.deepEqual(parseItemSpec("Up & Go [Chocolate]"), { item: "Up & Go", choices: [{ option: "Chocolate" }] });
  });
  it("Set=Option, several choices, and quantity", () => {
    assert.deepEqual(parseItemSpec("Ham & Cheese Sandwich [Bread Options=GLUTEN FREE; Extra=Mayo] x2"), {
      item: "Ham & Cheese Sandwich",
      quantity: 2,
      choices: [{ set: "Bread Options", option: "GLUTEN FREE" }, { set: "Extra", option: "Mayo" }],
    });
  });
  it("quantity without options", () => {
    assert.deepEqual(parseItemSpec("Cheese Sandwich x3"), { item: "Cheese Sandwich", quantity: 3 });
  });
});

describe("resolveLine (by name -> keys)", () => {
  it("resolves an item and a bare option name across the item's option sets", () => {
    assert.deepEqual(resolveLine(menu, parseItemSpec("Up & Go [Chocolate]")), { itemKey: "i-upgo", quantity: 1, optionKeys: ["o-choc"] });
  });
  it("is case-insensitive and accepts a unique substring", () => {
    assert.deepEqual(resolveLine(menu, { item: "ham & cheese", choices: [{ set: "bread", option: "gluten" }], quantity: 2 }), { itemKey: "i-ham", quantity: 2, optionKeys: ["o-gf"] });
  });
  it("prefers an exact name over a substring match", () => {
    assert.equal(findItem(menu, "Cheese Sandwich").key, "i-cheese"); // not 'Ham & Cheese Sandwich'
  });
  it("reports ambiguity among in-stock items", () => {
    rejectsWith(() => findItem(menu, "sandwich"), /Ambiguous item "sandwich": .*Cheese Sandwich.*Ham & Cheese Sandwich/, "not_found");
  });
  it("says so when the item exists but is not available that day", () => {
    rejectsWith(() => findItem(menu, "Fish Burrito"), /not available on 2026-11-06/, "precondition");
  });
  it("lists the available options, including sold-out ones, when the option is unknown", () => {
    rejectsWith(() => resolveLine(menu, parseItemSpec("Up & Go [Banana]")), /no option "Banana".*Vanilla \(sold out\), Chocolate, Strawberry/, "not_found");
  });
  it("resolves a sold-out option (validation of stock is the builder's job, with a clearer message)", () => {
    assert.deepEqual(resolveLine(menu, parseItemSpec("Up & Go [Vanilla]")).optionKeys, ["o-van"]);
  });
  it("unknown option group names the groups that exist", () => {
    rejectsWith(() => resolveLine(menu, parseItemSpec("Up & Go [Size=Large]")), /No option group "Size".*Up and Go flavour/, "not_found");
  });
});

describe("buildOrderItem (generic option handling)", () => {
  const line = (itemKey: string, optionKeys: string[] = [], quantity = 1): OrderLine => ({ itemKey, quantity, optionKeys });

  it("a plain item: price is the item price, no options", () => {
    const b = buildOrderItem(menu, line("i-cheese"));
    assert.deepEqual(b.line, { item: "Cheese Sandwich", quantity: 1, options: [], unitPrice: 4.3, lineTotal: 4.3 });
    assert.deepEqual(b.body, { itemKey: "i-cheese", quantity: 1, options: [], questions: [] });
  });

  it("a required option is chosen: body carries the option entry the app sends", () => {
    const b = buildOrderItem(menu, line("i-upgo", ["o-choc"]));
    assert.deepEqual(b.body.options, [{ optionKey: "o-choc", quantity: 1, isExcluded: false, isDefault: false }]);
    assert.equal(b.line.unitPrice, 3.8);
  });

  it("option prices are added to the item price (and multiplied by quantity)", () => {
    const one = buildOrderItem(menu, line("i-ham", ["o-gf"]));
    assert.equal(one.line.unitPrice, 6.4); // 5.40 + 1.00, as the app showed
    const three = buildOrderItem(menu, line("i-ham", ["o-gf"], 3));
    assert.equal(three.line.lineTotal, 19.2);
  });

  it("items whose price lives entirely in a required option set", () => {
    assert.equal(buildOrderItem(menu, line("i-pasta", ["o-s"])).line.unitPrice, 6.6);
  });

  it("a required set with no choice is refused, naming the in-stock choices", () => {
    rejectsWith(() => buildOrderItem(menu, line("i-upgo")), /needs a choice for "Up and Go flavour": Chocolate, Strawberry/, "precondition");
    rejectsWith(() => buildOrderItem(menu, line("i-ham")), /needs a choice for "Bread Options": White, Wholemeal, GLUTEN FREE \+\$1\.00/);
  });

  it("a sold-out option is refused and alternatives are offered", () => {
    rejectsWith(() => buildOrderItem(menu, line("i-upgo", ["o-van"])), /"Vanilla" is sold out \(available: Chocolate, Strawberry\)/, "precondition");
    rejectsWith(() => buildOrderItem(menu, line("i-pasta", ["o-x"])), /"XL" is sold out/);
  });

  it("too many choices in a single-choice set is refused", () => {
    rejectsWith(() => buildOrderItem(menu, line("i-upgo", ["o-choc", "o-straw"])), /allows at most 1/, "precondition");
  });

  it("an option that belongs to a different item, or a duplicate, is refused", () => {
    rejectsWith(() => buildOrderItem(menu, line("i-upgo", ["o-gf"])), /does not belong to "Up & Go"/);
    rejectsWith(() => buildOrderItem(menu, line("i-ham", ["o-gf", "o-gf"])), /Duplicate options/);
  });

  it("optional sets can be left empty", () => {
    // The allergy-alert item has only an optional set (null min in the API).
    assert.deepEqual(buildOrderItem(menu, line("i-allergy")).body.options, []);
  });

  it("refuses out-of-stock items, items with checkout questions, unknown items and bad quantities", () => {
    rejectsWith(() => buildOrderItem(menu, line("i-sold")), /not available/);
    rejectsWith(() => buildOrderItem(menu, line("i-asks")), /asks questions/);
    rejectsWith(() => buildOrderItem(menu, line("i-nope")), /not on the/, "not_found");
    rejectsWith(() => buildOrderItem(menu, line("i-cheese", [], 0)), /Quantity/);
  });
});
