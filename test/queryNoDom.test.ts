// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  type DiagnosticEvent,
  resetDiagnostics,
  setDiagnosticHook,
} from "../src/diagnostics/index.js"
import { createQuery } from "../src/resource/index.js"

describe("Query.enableWindowFocusRefetch without a DOM", () => {
  beforeEach(() => {
    resetDiagnostics()
    setDiagnosticHook(null)
  })

  it("degrades to a no-op and reports it instead of throwing", () => {
    const events: DiagnosticEvent[] = []
    setDiagnosticHook((event) => events.push(event))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const query = createQuery(async () => "data")
    const stop = query.enableWindowFocusRefetch()

    expect(() => stop()).not.toThrow()
    expect(() => query.dispose()).not.toThrow()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: "degraded",
      category: "Query.enableWindowFocusRefetch",
    })

    setDiagnosticHook(null)
    vi.restoreAllMocks()
  })
})
