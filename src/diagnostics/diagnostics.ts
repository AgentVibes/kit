/**
 * Runtime diagnostics — the house replacement for `// TODO` / `// FIXME`.
 *
 * A TODO never runs. These fire the first time the code path is actually hit,
 * dedup'd per key, greppable, and routable to a debug panel via the hook.
 *
 *   warnDegraded("Chart.scale", "linear interp; cubic deferred, upstream:120-140")
 *   warnNotImplemented("Export.pdf", "exists upstream, not ported yet")
 *   warnUnexpected("Api.parse", "expected number, got string", { value })
 */

export type DiagnosticKind = "not-implemented" | "degraded" | "unexpected"

export type DiagnosticEvent = {
  kind: DiagnosticKind
  category: string
  detail: string
  stack: string
  data?: Record<string, unknown>
  timestamp: number
}

export type DiagnosticHook = (event: DiagnosticEvent) => void

let hook: DiagnosticHook | null = null

/** Route every diagnostic to a debug panel, a logger, or a test spy. */
export function setDiagnosticHook(next: DiagnosticHook | null): void {
  hook = next
}

/** The currently installed hook, or null. */
export function getDiagnosticHook(): DiagnosticHook | null {
  return hook
}

const seen = new Set<string>()

/** Clear the dedup set (and, optionally in tests, start from a clean slate). */
export function resetDiagnostics(): void {
  seen.clear()
}

function miniStack(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(3, 6)
    .map((line) => line.trim())
    .join(" > ")
}

function emit(
  kind: DiagnosticKind,
  category: string,
  detail: string,
  data?: Record<string, unknown>,
): void {
  const event: DiagnosticEvent =
    data === undefined
      ? { kind, category, detail, stack: miniStack(), timestamp: Date.now() }
      : { kind, category, detail, stack: miniStack(), data, timestamp: Date.now() }
  hook?.(event)
}

/** This path works, but not the way it should. Fires once per category. */
export function warnDegraded(category: string, detail: string): void {
  const key = `degraded:${category}`
  if (seen.has(key)) return
  seen.add(key)
  emit("degraded", category, detail)
  console.warn(`⚡ DEGRADED ${category}: ${detail}`)
}

/** This path does nothing yet. Fires once per category. */
export function warnNotImplemented(category: string, detail: string): void {
  const key = `not-impl:${category}`
  if (seen.has(key)) return
  seen.add(key)
  emit("not-implemented", category, detail)
  console.warn(`⚠ NOT IMPLEMENTED ${category}: ${detail}`)
}

/** Reality contradicted an assumption. Always fires — never dedup'd. */
export function warnUnexpected(
  category: string,
  detail: string,
  data?: Record<string, unknown>,
): void {
  emit("unexpected", category, detail, data)
  console.error(`🔴 UNEXPECTED ${category}: ${detail}`, data ?? "")
}
