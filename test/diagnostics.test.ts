import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type DiagnosticEvent,
  resetDiagnostics,
  setDiagnosticHook,
  warnDegraded,
  warnNotImplemented,
  warnUnexpected,
} from "../src/diagnostics/index.js"

describe("runtime diagnostics", () => {
  let events: DiagnosticEvent[]

  beforeEach(() => {
    events = []
    resetDiagnostics()
    setDiagnosticHook((event) => events.push(event))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    setDiagnosticHook(null)
    resetDiagnostics()
    vi.restoreAllMocks()
  })

  it("reports a degraded path with its category and detail", () => {
    warnDegraded("Chart.scale", "linear interp; cubic deferred")

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: "degraded",
      category: "Chart.scale",
      detail: "linear interp; cubic deferred",
    })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it("fires a degraded warning only once per category", () => {
    warnDegraded("Chart.scale", "first")
    warnDegraded("Chart.scale", "second")

    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toBe("first")
  })

  it("dedups not-implemented separately from degraded on the same category", () => {
    warnDegraded("Export.pdf", "degraded")
    warnNotImplemented("Export.pdf", "missing")

    expect(events.map((e) => e.kind)).toEqual(["degraded", "not-implemented"])
  })

  it("fires again after resetDiagnostics", () => {
    warnNotImplemented("Export.pdf", "missing")
    resetDiagnostics()
    warnNotImplemented("Export.pdf", "missing")

    expect(events).toHaveLength(2)
  })

  it("never dedups warnUnexpected, and carries its data", () => {
    warnUnexpected("Api.parse", "expected number", { value: "x" })
    warnUnexpected("Api.parse", "expected number", { value: "y" })

    expect(events).toHaveLength(2)
    expect(events[0]?.data).toEqual({ value: "x" })
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it("omits the data key entirely when none is given", () => {
    warnUnexpected("Api.parse", "expected number")
    expect("data" in (events[0] ?? {})).toBe(false)
  })

  it("attaches a call-site stack to every event", () => {
    warnDegraded("Chart.scale", "detail")
    expect(events[0]?.stack).toEqual(expect.any(String))
  })

  it("stops reporting once the hook is cleared", () => {
    setDiagnosticHook(null)
    warnDegraded("Chart.scale", "detail")
    expect(events).toHaveLength(0)
  })
})
