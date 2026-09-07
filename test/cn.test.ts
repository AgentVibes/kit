import { describe, expect, it } from "vitest";
import { cn } from "../src/cn/index.js";

describe("cn", () => {
  it("joins plain class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy entries", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("resolves object and array forms", () => {
    expect(cn(["a", { b: true, c: false }])).toBe("a b");
  });

  it("lets a later Tailwind utility win over the one it conflicts with", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("keeps utilities that do not conflict", () => {
    expect(cn("p-2", "text-sm")).toBe("p-2 text-sm");
  });

  it("returns an empty string for no input", () => {
    expect(cn()).toBe("");
  });
});
