import { describe, expect, it } from "vitest";
import { Resource } from "../src/resource/index.js";

type User = { id: string; name: string };

const alice: User = { id: "u1", name: "Alice" };

// Keyed by the discriminant: a new Resource variant stops this file compiling.
const fixtures: Record<Resource<User>["status"], Resource<User>> = {
  idle: Resource.idle<User>(),
  loading: Resource.loading<User>(),
  ready: Resource.ready<User>(alice),
  error: Resource.error<User>(new Error("boom")),
};

describe("Resource", () => {
  it("builds each state with the status discriminator", () => {
    expect(Object.keys(fixtures).sort()).toEqual(["error", "idle", "loading", "ready"]);
    expect(fixtures.idle).toEqual({ status: "idle" });
    expect(fixtures.ready).toEqual({ status: "ready", value: alice });
  });

  it("omits progress entirely when loading has no measurable progress", () => {
    const state = Resource.loading<User>();
    expect(state).toEqual({ status: "loading" });
    expect("progress" in state).toBe(false);
  });

  it("keeps progress when one is given", () => {
    expect(Resource.loading<User>(0.25)).toEqual({ status: "loading", progress: 0.25 });
  });

  it("keeps a progress of zero rather than treating it as absent", () => {
    const state = Resource.loading<User>(0);
    expect(state).toEqual({ status: "loading", progress: 0 });
  });

  it("carries the error value on the error state", () => {
    const failure = new Error("network down");
    expect(Resource.error<User>(failure)).toEqual({ status: "error", error: failure });
  });
});
