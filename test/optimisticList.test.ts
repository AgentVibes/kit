import { describe, expect, it } from "vitest";
import { putBack, type Removal, takeOut } from "../src/resource/index.js";

type Media = { id: string; caption: string };

const keyOf = (item: Media) => item.id;
const media = (id: string): Media => ({ id, caption: `caption-${id}` });

const list: Media[] = [media("a"), media("b"), media("c")];

// Keyed by the discriminant: a new Removal variant stops this file compiling.
const removals: Record<Removal<Media>["kind"], Removal<Media>> = {
  removed: { kind: "removed", at: 1, item: media("b") },
  absent: { kind: "absent" },
};

describe("takeOut", () => {
  it("removes the item and remembers where it was", () => {
    const taken = takeOut(list, keyOf, "b");

    expect(taken.list.map(keyOf)).toEqual(["a", "c"]);
    expect(taken.removal).toEqual({ kind: "removed", at: 1, item: media("b") });
  });

  it("reports absent — not a missing value — when the key is not in the list", () => {
    const taken = takeOut(list, keyOf, "zzz");

    expect(taken.list.map(keyOf)).toEqual(["a", "b", "c"]);
    expect(taken.removal).toEqual({ kind: "absent" });
  });

  it("leaves the source list untouched", () => {
    takeOut(list, keyOf, "b");
    expect(list.map(keyOf)).toEqual(["a", "b", "c"]);
  });
});

describe("putBack", () => {
  it("restores the item at its original index", () => {
    const restored = putBack([media("a"), media("c")], removals.removed, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["a", "b", "c"]);
    expect(restored.inserted).toBe(true);
  });

  it("does nothing for an absent removal", () => {
    const restored = putBack([media("a")], removals.absent, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["a"]);
    expect(restored.inserted).toBe(false);
  });

  // The route-transition bug: the fetch re-ran, the server still reported the
  // item because the change never committed, and splicing on top mounted the
  // same id twice — a React duplicate key, and a count one too high.
  it("does not insert a duplicate when the list already contains the key", () => {
    const replaced = [media("a"), media("b"), media("c")];
    const restored = putBack(replaced, removals.removed, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["a", "b", "c"]);
    expect(restored.list).toHaveLength(3);
    expect(restored.inserted).toBe(false);
  });

  it("clamps to the end when the list shrank below the remembered index", () => {
    const shrunk = [media("a")];
    const restored = putBack(shrunk, { kind: "removed", at: 7, item: media("z") }, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["a", "z"]);
    expect(restored.inserted).toBe(true);
  });

  it("restores into an empty list", () => {
    const restored = putBack([], removals.removed, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["b"]);
    expect(restored.inserted).toBe(true);
  });

  it("round-trips take-out then put-back to the original order", () => {
    const taken = takeOut(list, keyOf, "b");
    const restored = putBack(taken.list, taken.removal, keyOf);

    expect(restored.list.map(keyOf)).toEqual(["a", "b", "c"]);
    expect(restored.inserted).toBe(true);
  });
});
