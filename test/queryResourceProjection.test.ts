import { describe, expect, it } from "vitest"
import { createQuery, type QueryState, toQueryViewState } from "../src/resource/index.js"

// Keyed by the discriminant, so a new QueryState variant stops this compiling
// before it can ship an unmapped projection.
const states: Record<QueryState<string>["status"], QueryState<string>> = {
  idle: { status: "idle" },
  pending: { status: "pending", fetchActivity: "fetching" },
  success: { status: "success", data: "v1", dataUpdatedAt: 1000, fetchActivity: "idle" },
  error: { status: "error", error: new Error("boom"), fetchActivity: "idle" },
  "stale-error": {
    status: "stale-error",
    data: "v1",
    dataUpdatedAt: 1000,
    error: new Error("refetch failed"),
    fetchActivity: "idle",
  },
}

describe("QueryState → QueryViewState projection", () => {
  it("maps idle to idle", () => {
    expect(toQueryViewState(states.idle, false)).toEqual({ status: "idle" })
  })

  it("maps pending to loading", () => {
    expect(toQueryViewState(states.pending, false)).toEqual({ status: "loading" })
  })

  it("maps success to ready and reports revalidation on the ready arm", () => {
    expect(toQueryViewState(states.success, false)).toEqual({
      status: "ready",
      value: "v1",
      revalidating: false,
      stale: false,
    })
    const revalidating: QueryState<string> = {
      status: "success",
      data: "v1",
      dataUpdatedAt: 1000,
      fetchActivity: "fetching",
    }
    expect(toQueryViewState(revalidating, false)).toMatchObject({
      status: "ready",
      revalidating: true,
    })
  })

  it("maps stale-error to ready, always stale, with the error still readable", () => {
    const view = toQueryViewState(states["stale-error"], false)
    expect(view).toMatchObject({ status: "ready", value: "v1", stale: true })
    expect(view.status === "ready" ? view.error?.message : null).toBe("refetch failed")
  })

  it("leaves error off the ready arm when the data is simply fresh", () => {
    const view = toQueryViewState(states.success, false)
    expect("error" in view).toBe(false)
  })

  it("maps error to error", () => {
    expect(toQueryViewState(states.error, false)).toMatchObject({
      status: "error",
      revalidating: false,
    })
  })
})

describe("Query.resource", () => {
  it("reads idle before anything is requested", () => {
    expect(createQuery(async () => "v").resource).toEqual({ status: "idle" })
  })

  it("reads loading during the first fetch", () => {
    const query = createQuery(() => new Promise<string>(() => {}))
    void query.fetch()
    expect(query.resource).toEqual({ status: "loading" })
  })

  it("reads ready with the value once data arrives", async () => {
    const query = createQuery(async () => "v1")
    await query.fetch()
    expect(query.resource).toEqual({ status: "ready", value: "v1" })
  })

  it("reads error when the first fetch failed", async () => {
    const query = createQuery<string>(() => Promise.reject(new Error("boom")))
    await query.fetch()
    expect(query.resource).toMatchObject({ status: "error" })
  })

  it("reads ready — not error — when a refetch failed over existing data", async () => {
    let call = 0
    const query = createQuery(async () => {
      call += 1
      if (call === 1) return "v1"
      throw new Error("refetch failed")
    })

    await query.fetch()
    await query.invalidate()

    // The old data is still on screen, so the Resource is ready; the failure
    // stays readable on query.error rather than blanking the view.
    expect(query.resource).toEqual({ status: "ready", value: "v1" })
    expect(query.error?.message).toBe("refetch failed")
  })
})
