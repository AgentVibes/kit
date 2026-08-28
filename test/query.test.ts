import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createQuery, Query } from "../src/resource/index.js"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the pending microtask queue drain so a flow's state lands. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("Query state transitions", () => {
  it("starts idle so a gated load has a state to sit in", () => {
    const query = createQuery(async () => "data")
    expect(query.state).toEqual({ status: "idle" })
    expect(query.isLoading).toBe(false)
    expect(query.hasData).toBe(false)
    expect(query.data).toBeNull()
  })

  it("goes pending+fetching synchronously when fetch starts", () => {
    const gate = deferred<string>()
    const query = createQuery(() => gate.promise)

    void query.fetch()

    expect(query.state).toEqual({ status: "pending", fetchActivity: "fetching" })
    expect(query.isLoading).toBe(true)
    gate.resolve("done")
  })

  it("reaches success with data after the fetcher resolves", async () => {
    const query = createQuery(async () => "hello")

    await query.fetch()

    expect(query.state.status).toBe("success")
    expect(query.data).toBe("hello")
    expect(query.hasData).toBe(true)
    expect(query.isFetching).toBe(false)
    expect(query.error).toBeNull()
  })

  it("reaches error with no data when the first fetch fails", async () => {
    const query = createQuery(async () => {
      throw new Error("network down")
    })

    await query.fetch()

    expect(query.state.status).toBe("error")
    expect(query.error?.message).toBe("network down")
    expect(query.data).toBeNull()
  })

  it("wraps a non-Error rejection into an Error", async () => {
    const query = createQuery<string>(() => Promise.reject("plain string"))

    await query.fetch()

    expect(query.error).toBeInstanceOf(Error)
    expect(query.error?.message).toBe("plain string")
  })

  it("uses a custom normalizeError for a non-Error error channel", async () => {
    const query = new Query<string, string>({
      fetcher: async () => {
        throw new Error("boom")
      },
      normalizeError: (err) => (err instanceof Error ? err.message : "unknown"),
    })

    await query.fetch()

    expect(query.state).toEqual({ status: "error", error: "boom", fetchActivity: "idle" })
  })

  it("never rejects when the fetcher rejects", async () => {
    const query = createQuery<string>(() => Promise.reject(new Error("boom")))
    await expect(query.fetch()).resolves.toBeUndefined()
  })
})

describe("Query stale-while-revalidate", () => {
  it("stays success with data while a revalidation is in flight", async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let call = 0
    const query = createQuery(() => {
      call += 1
      return call === 1 ? first.promise : second.promise
    })

    void query.fetch()
    first.resolve("v1")
    await settle()

    void query.invalidate()

    expect(query.state).toMatchObject({ status: "success", data: "v1", fetchActivity: "fetching" })
    expect(query.isFetching).toBe(true)
    // A revalidation over existing data is not a "loading" first paint.
    expect(query.isLoading).toBe(false)
    expect(query.viewState).toMatchObject({ status: "ready", value: "v1", revalidating: true })

    second.resolve("v2")
    await settle()
    expect(query.data).toBe("v2")
  })

  it("keeps the previous data as stale-error when a refetch fails", async () => {
    let call = 0
    const query = createQuery(async () => {
      call += 1
      if (call === 1) return "v1"
      throw new Error("refetch failed")
    })

    await query.fetch()
    await query.invalidate()

    expect(query.state.status).toBe("stale-error")
    expect(query.data).toBe("v1")
    expect(query.error?.message).toBe("refetch failed")
    expect(query.isStale).toBe(true)
    expect(query.viewState).toMatchObject({ status: "ready", value: "v1", stale: true })
  })

  it("recovers from stale-error back to success on the next good fetch", async () => {
    let call = 0
    const query = createQuery(async () => {
      call += 1
      if (call === 2) throw new Error("blip")
      return `v${call}`
    })

    await query.fetch()
    await query.invalidate()
    expect(query.state.status).toBe("stale-error")

    await query.invalidate()
    expect(query.state.status).toBe("success")
    expect(query.data).toBe("v3")
    expect(query.error).toBeNull()
  })
})

describe("Query deduplication and throttling", () => {
  it("calls the fetcher once for concurrent fetches and shares the promise", async () => {
    const gate = deferred<string>()
    const fetcher = vi.fn(() => gate.promise)
    const query = createQuery(fetcher)

    const a = query.fetch()
    const b = query.fetch()
    const c = query.invalidate()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
    expect(c).toBe(a)

    gate.resolve("done")
    await Promise.all([a, b, c])
    expect(query.data).toBe("done")
  })

  it("skips a second fetch inside the throttle window", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { throttleMs: 10_000 })

    await query.fetch()
    await query.fetch()

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("lets invalidate bypass the throttle window", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { throttleMs: 10_000 })

    await query.fetch()
    await query.invalidate()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe("Query enabled gate", () => {
  it("stays idle and does not call the fetcher while disabled", async () => {
    const fetcher = vi.fn(async () => "data")
    let ready = false
    const query = createQuery(fetcher, { enabled: () => ready })

    await query.fetch()
    await query.invalidate()

    expect(fetcher).not.toHaveBeenCalled()
    expect(query.state).toEqual({ status: "idle" })
    expect(query.enabled).toBe(false)

    ready = true
    await query.fetch()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(query.data).toBe("data")
  })
})

describe("Query staleness", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("becomes stale once staleTimeMs has passed since the data arrived", async () => {
    const query = createQuery(async () => "data", { staleTimeMs: 1000 })

    await query.fetch()

    expect(query.isStale).toBe(false)
    vi.advanceTimersByTime(1001)
    expect(query.isStale).toBe(true)
  })
})
