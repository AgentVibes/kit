import { describe, expect, it, vi } from "vitest"
import {
  createMutation,
  Mutation,
  type MutationResult,
  type MutationState,
} from "../src/resource/index.js"

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
  let resolve: (v: T) => void = () => {}
  // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Keyed by the discriminant: a new arm on either union stops this compiling.
const states: Record<MutationState["status"], MutationState> = {
  idle: { status: "idle" },
  saving: { status: "saving" },
  ok: { status: "ok" },
  error: { status: "error", error: new Error("boom") },
}

const results: Record<MutationResult<string>["status"], MutationResult<string>> = {
  ok: { status: "ok", data: "saved" },
  error: { status: "error", error: new Error("boom") },
  busy: { status: "busy" },
}

describe("Mutation state transitions", () => {
  it("reads idle for a key that never ran", () => {
    const mutations = createMutation()
    expect(mutations.get("createGallery")).toEqual(states.idle)
    expect(mutations.size).toBe(0)
  })

  it("goes saving synchronously and ok on success", async () => {
    const gate = deferred<string>()
    const mutations = createMutation()

    const running = mutations.run("createGallery", () => gate.promise)
    expect(mutations.get("createGallery")).toEqual(states.saving)
    expect(mutations.savingKeys).toEqual(["createGallery"])

    gate.resolve("gallery-1")
    const result = await running

    expect(result).toEqual({ status: "ok", data: "gallery-1" })
    expect(mutations.get("createGallery")).toEqual(states.ok)
  })

  it("lands on error with the failure readable", async () => {
    const mutations = createMutation()

    const result = await mutations.run("createGallery", () =>
      Promise.reject(new Error("server said no")),
    )

    expect(result.status).toBe("error")
    expect(mutations.get("createGallery")).toMatchObject({ status: "error" })
    const state = mutations.get("createGallery")
    expect(state.status === "error" ? state.error.message : null).toBe("server said no")
  })

  it("wraps a non-Error rejection into an Error", async () => {
    const mutations = createMutation()
    const result = await mutations.run("k", () => Promise.reject("plain string"))

    expect(result.status === "error" ? result.error : null).toBeInstanceOf(Error)
    expect(result.status === "error" ? result.error.message : null).toBe("plain string")
  })

  it("uses a custom normalizeError for a non-Error error channel", async () => {
    const mutations = new Mutation<string>({
      normalizeError: (err) => (err instanceof Error ? err.message : "unknown"),
    })

    const result = await mutations.run("k", () => Promise.reject(new Error("boom")))

    expect(result).toEqual({ status: "error", error: "boom" })
    expect(mutations.get("k")).toEqual({ status: "error", error: "boom" })
  })

  it("never rejects when the request rejects", async () => {
    const mutations = createMutation()
    await expect(
      mutations.run("k", () => Promise.reject(new Error("boom"))),
    ).resolves.toMatchObject({ status: "error" })
  })

  it("calls onOk with the parsed data, on success only", async () => {
    const onOk = vi.fn()
    const mutations = createMutation()

    await mutations.run("k", async () => "payload", { onOk })
    expect(onOk).toHaveBeenCalledExactlyOnceWith("payload")

    await mutations.run("k", () => Promise.reject(new Error("boom")), { onOk })
    expect(onOk).toHaveBeenCalledTimes(1)
  })
})

describe("Mutation keys are independent", () => {
  it("runs concurrent mutations on different keys without crosstalk", async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const mutations = createMutation()

    const a = mutations.run("deleteMedia:a", () => first.promise)
    const b = mutations.run("deleteMedia:b", () => second.promise)

    expect(mutations.get("deleteMedia:a")).toEqual(states.saving)
    expect(mutations.get("deleteMedia:b")).toEqual(states.saving)
    expect(mutations.savingKeys.sort()).toEqual(["deleteMedia:a", "deleteMedia:b"])

    second.reject(new Error("b failed"))
    await b
    // b failing must not disturb a, which is still in flight.
    expect(mutations.get("deleteMedia:b")).toMatchObject({ status: "error" })
    expect(mutations.get("deleteMedia:a")).toEqual(states.saving)

    first.resolve("a done")
    await a
    expect(mutations.get("deleteMedia:a")).toEqual(states.ok)
    expect(mutations.get("deleteMedia:b")).toMatchObject({ status: "error" })
  })
})

describe("Mutation in-flight guard", () => {
  // Asserts on the request count directly, without awaiting the second call —
  // so removing the guard fails as "expected 1, got 2" rather than as a
  // timeout, which would be a much vaguer signal.
  it("does not send a second request for a key already in flight", () => {
    const gate = deferred<string>()
    const request = vi.fn(() => gate.promise)
    const mutations = createMutation()

    void mutations.run("moveMedia", request)
    void mutations.run("moveMedia", request)

    expect(request).toHaveBeenCalledTimes(1)
    gate.resolve("done")
  })

  it("sends nothing and reports busy when the same key is already in flight", async () => {
    const gate = deferred<string>()
    const request = vi.fn(() => gate.promise)
    const mutations = createMutation()

    const first = mutations.run("moveMedia", request)
    const second = await mutations.run("moveMedia", request)

    // The whole point of the guard: one request left the building, not two.
    expect(request).toHaveBeenCalledTimes(1)
    expect(second).toEqual(results.busy)

    gate.resolve("done")
    await first
    expect(mutations.get("moveMedia")).toEqual(states.ok)
  })

  it("never applies the optimistic edit of a busy call", async () => {
    const gate = deferred<string>()
    const optimistic = vi.fn(() => vi.fn())
    const mutations = createMutation()

    const first = mutations.run("moveMedia", () => gate.promise, { optimistic })
    await mutations.run("moveMedia", () => gate.promise, { optimistic })

    expect(optimistic).toHaveBeenCalledTimes(1)
    gate.resolve("done")
    await first
  })

  it("accepts a new run for the key once the first one lands", async () => {
    const request = vi.fn(async () => "ok")
    const mutations = createMutation()

    await mutations.run("k", request)
    await mutations.run("k", request)

    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe("Mutation reset", () => {
  it("returns a key to idle", async () => {
    const mutations = createMutation()
    await mutations.run("k", () => Promise.reject(new Error("boom")))

    mutations.reset("k")
    expect(mutations.get("k")).toEqual(states.idle)
    expect(mutations.size).toBe(0)
  })

  it("resetAll clears every key", async () => {
    const mutations = createMutation()
    await mutations.run("a", async () => "ok")
    await mutations.run("b", async () => "ok")

    mutations.resetAll()
    expect(mutations.size).toBe(0)
  })

  // reset() clears the badge; it must not open a double-submit hole, so the
  // guard tracks in-flight requests separately from the rendered state.
  it("does not let a reset during flight start a second request", async () => {
    const gate = deferred<string>()
    const request = vi.fn(() => gate.promise)
    const mutations = createMutation()

    const first = mutations.run("moveMedia", request)
    mutations.reset("moveMedia")
    expect(mutations.get("moveMedia")).toEqual(states.idle)
    expect(mutations.isInFlight("moveMedia")).toBe(true)

    const second = await mutations.run("moveMedia", request)

    expect(request).toHaveBeenCalledTimes(1)
    expect(second).toEqual(results.busy)
    // A request for the key really is in flight, so the badge says so again.
    expect(mutations.get("moveMedia")).toEqual(states.saving)

    gate.resolve("done")
    await first
    expect(mutations.isInFlight("moveMedia")).toBe(false)
  })
})

describe("Mutation optimistic rollback", () => {
  it("rolls the edit back when the request fails", async () => {
    let list = ["a", "b", "c"]
    const mutations = createMutation()

    const result = await mutations.run("deleteMedia:b", () => Promise.reject(new Error("boom")), {
      optimistic: () => {
        const before = list
        list = list.filter((item) => item !== "b")
        return () => {
          list = before
        }
      },
    })

    expect(result.status).toBe("error")
    expect(list).toEqual(["a", "b", "c"])
  })

  it("keeps the edit when the request succeeds", async () => {
    let list = ["a", "b", "c"]
    const rollback = vi.fn()
    const mutations = createMutation()

    await mutations.run("deleteMedia:b", async () => "deleted", {
      optimistic: () => {
        list = list.filter((item) => item !== "b")
        return rollback
      },
    })

    expect(list).toEqual(["a", "c"])
    expect(rollback).not.toHaveBeenCalled()
  })

  it("applies the edit before the request is awaited", () => {
    const gate = deferred<string>()
    const applied: string[] = []
    const mutations = createMutation()

    void mutations.run("k", () => gate.promise, {
      optimistic: () => {
        applied.push("applied")
        return () => applied.push("rolled back")
      },
    })

    expect(applied).toEqual(["applied"])
    gate.resolve("done")
  })
})
