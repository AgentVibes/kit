import { act, render } from "@testing-library/react"
import { StrictMode, useEffect } from "react"
import { describe, expect, it, vi } from "vitest"
import { usePageStore } from "../src/react/index.js"

class CountingStore {
  disposed = 0
  constructor(readonly label: string) {}
  dispose(): void {
    this.disposed += 1
  }
}

/** Flush the microtask the deferred disposal is scheduled on. */
const flush = () => act(async () => {})

describe("usePageStore under StrictMode", () => {
  it("builds the store exactly once across the double mount", async () => {
    const factory = vi.fn(() => new CountingStore("page"))

    function Screen() {
      usePageStore(factory, [])
      return <div>screen</div>
    }

    render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    )
    await flush()

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("never disposes the store the mounted component is holding", async () => {
    const store = new CountingStore("page")
    const seen: number[] = []

    function Screen() {
      const held = usePageStore(() => store, [])
      useEffect(() => {
        seen.push(held.disposed)
      })
      return <div>screen</div>
    }

    render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    )
    await flush()

    // Both StrictMode effect runs observed a live store.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen).toEqual(seen.map(() => 0))
    expect(store.disposed).toBe(0)
  })

  it("disposes exactly once, and only after the real unmount", async () => {
    const store = new CountingStore("page")

    function Screen() {
      usePageStore(() => store, [])
      return <div>screen</div>
    }

    const view = render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    )
    await flush()
    expect(store.disposed).toBe(0)

    view.unmount()
    await flush()

    expect(store.disposed).toBe(1)
  })
})

describe("usePageStore lifecycle", () => {
  it("disposes on unmount outside StrictMode too", async () => {
    const store = new CountingStore("page")

    function Screen() {
      usePageStore(() => store, [])
      return <div>screen</div>
    }

    const view = render(<Screen />)
    await flush()
    expect(store.disposed).toBe(0)

    view.unmount()
    await flush()
    expect(store.disposed).toBe(1)
  })

  it("keeps the same store across re-renders with unchanged deps", async () => {
    const factory = vi.fn(() => new CountingStore("page"))
    const seen: CountingStore[] = []

    function Screen({ tick }: { tick: number }) {
      const store = usePageStore(factory, [])
      seen.push(store)
      return <div>{tick}</div>
    }

    const view = render(<Screen tick={1} />)
    view.rerender(<Screen tick={2} />)
    await flush()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(new Set(seen).size).toBe(1)
  })

  it("rebuilds and disposes the old store when deps change", async () => {
    const built: CountingStore[] = []

    function Screen({ slug }: { slug: string }) {
      const store = usePageStore(() => {
        const created = new CountingStore(slug)
        built.push(created)
        return created
      }, [slug])
      return <div>{store.label}</div>
    }

    const view = render(<Screen slug="a" />)
    await flush()
    view.rerender(<Screen slug="b" />)
    await flush()

    expect(built.map((s) => s.label)).toEqual(["a", "b"])
    expect(built[0]?.disposed).toBe(1)
    expect(built[1]?.disposed).toBe(0)

    view.unmount()
    await flush()
    expect(built[1]?.disposed).toBe(1)
  })

  it("accepts a store with no dispose method", async () => {
    function Screen() {
      const store = usePageStore(() => ({ title: "plain" }), [])
      return <div>{store.title}</div>
    }

    const view = render(<Screen />)
    expect(view.container.textContent).toBe("plain")

    expect(() => view.unmount()).not.toThrow()
    await flush()
  })
})
