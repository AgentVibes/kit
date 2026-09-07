import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { QueryView, ShowWhen } from "../src/react/index.js"
import { createQuery, type Query } from "../src/resource/index.js"

function renderView(query: Query<string>) {
  return render(
    <QueryView
      query={query}
      idle={() => <div>idle</div>}
      loading={() => <div>loading</div>}
      error={({ error, retry }) => (
        <div>
          <span>error:{error.message}</span>
          <button type="button" onClick={retry}>
            retry
          </button>
        </div>
      )}
      ready={({ value, revalidating, stale, error }) => (
        <div>
          ready:{value}|revalidating:{String(revalidating)}|stale:{String(stale)}|error:
          {error?.message ?? "none"}
        </div>
      )}
    />,
  )
}

describe("QueryView", () => {
  it("renders the idle slot before anything is requested", () => {
    const view = renderView(createQuery(async () => "v1"))
    expect(view.container.textContent).toBe("idle")
  })

  it("falls back to the loading slot when no idle slot is given", () => {
    const query = createQuery(async () => "v1")
    const view = render(
      <QueryView
        query={query}
        loading={() => <div>loading</div>}
        error={() => <div>error</div>}
        ready={({ value }) => <div>{value}</div>}
      />,
    )
    expect(view.container.textContent).toBe("loading")
  })

  it("renders the loading slot during the first fetch", () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
    const query = createQuery(() => new Promise<string>(() => {}))
    const view = renderView(query)

    act(() => {
      void query.fetch()
    })

    expect(view.container.textContent).toBe("loading")
  })

  it("renders the ready slot with the value once data arrives", async () => {
    const query = createQuery(async () => "v1")
    const view = renderView(query)

    await act(async () => {
      await query.fetch()
    })

    expect(view.container.textContent).toBe("ready:v1|revalidating:false|stale:false|error:none")
  })

  it("keeps the ready slot and flags revalidating while a refetch is in flight", async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
    let resolveSecond: (value: string) => void = () => {}
    let call = 0
    const query = createQuery(() => {
      call += 1
      if (call === 1) return Promise.resolve("v1")
      return new Promise<string>((resolve) => {
        resolveSecond = resolve
      })
    })
    const view = renderView(query)

    await act(async () => {
      await query.fetch()
    })
    act(() => {
      void query.invalidate()
    })

    expect(view.container.textContent).toBe("ready:v1|revalidating:true|stale:false|error:none")

    await act(async () => {
      resolveSecond("v2")
    })
    expect(view.container.textContent).toBe("ready:v2|revalidating:false|stale:false|error:none")
  })

  it("renders the ready slot with the stale flag and the error after a failed refetch", async () => {
    let call = 0
    const query = createQuery(async () => {
      call += 1
      if (call === 1) return "v1"
      throw new Error("refetch failed")
    })
    const view = renderView(query)

    await act(async () => {
      await query.fetch()
      await query.invalidate()
    })

    expect(view.container.textContent).toBe(
      "ready:v1|revalidating:false|stale:true|error:refetch failed",
    )
  })

  it("renders the error slot when the first fetch fails", async () => {
    const query = createQuery<string>(() => Promise.reject(new Error("network down")))
    const view = renderView(query)

    await act(async () => {
      await query.fetch()
    })

    expect(view.container.textContent).toContain("error:network down")
  })

  it("retries from the error slot", async () => {
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error("network down")
      return "v1"
    })
    const query = createQuery(fetcher)
    const view = renderView(query)

    await act(async () => {
      await query.fetch()
    })

    const button = view.getByRole("button", { name: "retry" })
    await act(async () => {
      button.click()
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain("ready:v1")
  })

  it("re-renders on a state change without the parent re-rendering", async () => {
    const query = createQuery(async () => "v1")
    let parentRenders = 0

    function Parent() {
      parentRenders += 1
      return (
        <QueryView
          query={query}
          loading={() => <div>loading</div>}
          error={() => <div>error</div>}
          ready={({ value }) => <div>{value}</div>}
        />
      )
    }

    const view = render(<Parent />)
    const rendersBefore = parentRenders

    await act(async () => {
      await query.fetch()
    })

    expect(view.container.textContent).toBe("v1")
    expect(parentRenders).toBe(rendersBefore)
  })
})

describe("ShowWhen", () => {
  it("renders children when the condition holds", () => {
    const view = render(<ShowWhen when={true}>shown</ShowWhen>)
    expect(view.container.textContent).toBe("shown")
  })

  it("renders nothing by default when the condition fails", () => {
    const view = render(<ShowWhen when={false}>shown</ShowWhen>)
    expect(view.container.textContent).toBe("")
  })

  it("renders the fallback when the condition fails", () => {
    const view = render(
      <ShowWhen when={false} fallback={<span>empty</span>}>
        shown
      </ShowWhen>,
    )
    expect(view.container.textContent).toBe("empty")
  })
})
