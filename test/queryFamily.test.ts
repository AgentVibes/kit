import { describe, expect, it, vi } from "vitest";
import { createQuery, Query, QueryFamily } from "../src/resource/index.js";

describe("QueryFamily", () => {
  it("returns the same Query instance for the same key", () => {
    const create = vi.fn((key: string) => createQuery(async () => `data:${key}`));
    const family = new QueryFamily<string, string>(create);

    const first = family.get("2026-08");
    const second = family.get("2026-08");

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a distinct Query per key", () => {
    const family = new QueryFamily<string, string>((key) => createQuery(async () => `data:${key}`));

    const august = family.get("2026-08");
    const september = family.get("2026-09");

    expect(september).not.toBe(august);
    expect(family.size).toBe(2);
    expect(family.keys().sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("fetches per key without crosstalk", async () => {
    const family = new QueryFamily<string, string>((key) => createQuery(async () => `data:${key}`));

    await family.get("a").fetch();

    expect(family.get("a").data).toBe("data:a");
    expect(family.get("b").data).toBeNull();
    expect(family.get("b").state).toEqual({ status: "idle" });
  });

  it("peek never creates an entry", () => {
    const create = vi.fn((key: string) => createQuery(async () => `data:${key}`));
    const family = new QueryFamily<string, string>(create);

    expect(family.peek("missing")).toBeUndefined();
    expect(family.has("missing")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("remove disposes the entry and reports whether one was there", () => {
    const disposals: string[] = [];
    const family = new QueryFamily<string, string>((key) => {
      const query = createQuery(async () => `data:${key}`);
      vi.spyOn(query, "dispose").mockImplementation(() => disposals.push(key));
      return query;
    });

    family.get("a");
    expect(family.remove("a")).toBe(true);
    expect(family.remove("a")).toBe(false);
    expect(disposals).toEqual(["a"]);
    expect(family.size).toBe(0);
  });

  it("dispose releases every entry and empties the family", () => {
    const disposals: string[] = [];
    const family = new QueryFamily<string, string>((key) => {
      const query = new Query<string>({ fetcher: async () => `data:${key}` });
      vi.spyOn(query, "dispose").mockImplementation(() => disposals.push(key));
      return query;
    });

    family.get("a");
    family.get("b");
    family.dispose();

    expect(disposals.sort()).toEqual(["a", "b"]);
    expect(family.size).toBe(0);
  });

  it("hands out a fresh Query after the family was disposed", () => {
    const family = new QueryFamily<string, string>((key) => createQuery(async () => `data:${key}`));

    const before = family.get("a");
    family.dispose();
    const after = family.get("a");

    expect(after).not.toBe(before);
  });

  it("invalidateAll refetches every live entry", async () => {
    const calls: string[] = [];
    const family = new QueryFamily<string, string>((key) =>
      createQuery(async () => {
        calls.push(key);
        return `data:${key}`;
      }),
    );

    family.get("a");
    family.get("b");
    await family.invalidateAll();

    expect(calls.sort()).toEqual(["a", "b"]);
  });
});
