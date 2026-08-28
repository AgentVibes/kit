import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createQuery } from "../src/resource/index.js"

describe("Query refetch interval", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("refetches on every tick even when the interval is shorter than the throttle", async () => {
    const fetcher = vi.fn(async () => "data")
    // throttleMs defaults to 2000, so ticks driven through fetch() would be
    // swallowed. Ticks go through invalidate() precisely to avoid that.
    const query = createQuery(fetcher, { refetchIntervalMs: 1000 })

    query.enableRefetchInterval()
    await vi.advanceTimersByTimeAsync(3000)

    expect(fetcher).toHaveBeenCalledTimes(3)
    query.dispose()
  })

  it("stops ticking after dispose", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { refetchIntervalMs: 1000 })

    query.enableRefetchInterval()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetcher).toHaveBeenCalledTimes(2)

    query.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("stops ticking after the returned disposer runs", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { refetchIntervalMs: 1000 })

    const stop = query.enableRefetchInterval()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe("Query window focus refetch", () => {
  it("refetches on visibilitychange once the data is stale", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { staleTimeMs: 0, throttleMs: 0 })

    await query.fetch()
    expect(fetcher).toHaveBeenCalledTimes(1)

    query.enableWindowFocusRefetch()
    document.dispatchEvent(new Event("visibilitychange"))
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    query.dispose()
  })

  it("does not refetch on visibilitychange while the data is fresh", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { staleTimeMs: 60_000, throttleMs: 0 })

    await query.fetch()
    query.enableWindowFocusRefetch()
    document.dispatchEvent(new Event("visibilitychange"))
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(1)
    query.dispose()
  })

  // The donor bug: dispose() nulled its handler but left the listener attached
  // to the document for the lifetime of the page, holding `this` alive.
  it("removes the visibilitychange listener on dispose", async () => {
    const fetcher = vi.fn(async () => "data")
    const query = createQuery(fetcher, { staleTimeMs: 0, throttleMs: 0 })

    await query.fetch()
    query.enableWindowFocusRefetch()
    query.dispose()

    document.dispatchEvent(new Event("visibilitychange"))
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("detaches exactly the listener it attached", () => {
    const addSpy = vi.spyOn(document, "addEventListener")
    const removeSpy = vi.spyOn(document, "removeEventListener")
    const query = createQuery(async () => "data")

    query.enableWindowFocusRefetch()
    query.dispose()

    const added = addSpy.mock.calls.find(([type]) => type === "visibilitychange")
    const removed = removeSpy.mock.calls.find(([type]) => type === "visibilitychange")
    expect(added).toBeDefined()
    expect(removed).toBeDefined()
    expect(removed?.[1]).toBe(added?.[1])

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it("is idempotent: a second dispose neither throws nor detaches twice", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener")
    const query = createQuery(async () => "data")

    query.enableWindowFocusRefetch()
    query.dispose()
    query.dispose()

    const removals = removeSpy.mock.calls.filter(([type]) => type === "visibilitychange")
    expect(removals).toHaveLength(1)
    removeSpy.mockRestore()
  })
})
