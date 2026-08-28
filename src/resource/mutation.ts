import { flow, makeAutoObservable, observable } from "mobx"

/**
 * Per-control mutation state, observed by the UI so every async control can
 * render idle / saving / ok / error distinctly — the write half of the
 * four-state rule.
 */
export type MutationState<E = Error> =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "ok" }
  | { status: "error"; error: E }

/**
 * What `run()` gives the caller back.
 *
 * `busy` is its own arm on purpose: a second `run()` on a key that is already
 * in flight sends nothing, and saying so is neither "it succeeded" nor "it
 * failed". Callers that branch on the outcome get told the truth instead of a
 * fabricated failure.
 */
export type MutationResult<T, E = Error> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E }
  | { status: "busy" }

type BaseMutationOptions = {
  debugLabel?: string
}

/** Same rule as `QueryOptions`: only `E = Error` may omit the normalizer. */
export type MutationOptions<E = Error> = BaseMutationOptions &
  (E extends Error
    ? { normalizeError?: (err: unknown) => E }
    : { normalizeError: (err: unknown) => E })

export type RunOptions<T> = {
  /** Called with the parsed result before `run()` resolves, on success only. */
  onOk?: (data: T) => void
  /**
   * Apply an optimistic edit now and return the function that undoes it.
   * The rollback runs if — and only if — the request fails. It never runs on
   * success, and never on `busy`, where nothing was applied.
   */
  optimistic?: () => () => void
}

type PrivateKeys = "options" | "inflight" | "normalize"

/**
 * A keyed set of write operations, each with its own observable state.
 *
 * Keys are the caller's, and stable: `"createGallery"`, `` `deleteMedia:${id}` ``,
 * `` `approveMedia:${id}` ``. One instance per store covers every control on
 * the screen, and two controls never share a spinner.
 *
 *   const result = await store.mutations.run(
 *     `deleteMedia:${id}`,
 *     () => api.deleteMedia(id),
 *     { optimistic: () => store.removeMediaOptimistically(id) },
 *   )
 *
 * Concurrency: a second `run()` on a key already in flight sends nothing and
 * returns `busy` — the conservative default, since a double-submitted write is
 * usually a bug rather than a queue. Queueing was the alternative; if a caller
 * needs it, it belongs in that caller where the ordering rules are known.
 */
export class Mutation<E = Error> {
  private readonly states = observable.map<string, MutationState<E>>()
  /**
   * In-flight keys, tracked separately from `states` and deliberately not
   * observable. `reset(key)` clears the rendered badge — that is its whole
   * job — but it must not open a double-submit hole, so the guard reads this
   * instead of looking for a `saving` state.
   */
  private readonly inflight = new Set<string>()
  private options: MutationOptions<E>

  constructor(options: MutationOptions<E>) {
    this.options = options
    makeAutoObservable<Mutation<E>, PrivateKeys>(this, {
      options: false,
      inflight: false,
      normalize: false,
    })
  }

  /** State of one key. Keys never run read as idle. */
  get(key: string): MutationState<E> {
    return this.states.get(key) ?? { status: "idle" }
  }

  /** Whether a request for `key` is in flight, regardless of the rendered state. */
  isInFlight(key: string): boolean {
    return this.inflight.has(key)
  }

  /** Keys currently rendering as `saving`. */
  get savingKeys(): string[] {
    return [...this.states.entries()]
      .filter(([, state]) => state.status === "saving")
      .map(([key]) => key)
  }

  get size(): number {
    return this.states.size
  }

  /**
   * Return a key to idle — the "clear" affordance behind the four-state rule
   * (dismiss an error, drop a lingering checkmark) and the way accumulated
   * per-item keys are freed.
   *
   * This clears the badge only. It does not cancel a request in flight, and
   * the key stays guarded until that request lands.
   */
  reset(key: string): void {
    this.states.delete(key)
  }

  resetAll(): void {
    this.states.clear()
  }

  /**
   * Run a write for `key`: `saving`, then `ok` or `error`. Never rejects — a
   * failed request lands in the state and in the returned result.
   */
  run<T>(
    key: string,
    request: () => Promise<T>,
    runOptions: RunOptions<T> = {},
  ): Promise<MutationResult<T, E>> {
    if (this.inflight.has(key)) {
      // A request for this key really is in flight, so `saving` is the honest
      // badge even if the caller had cleared it.
      this.states.set(key, { status: "saving" })
      return Promise.resolve({ status: "busy" })
    }

    this.inflight.add(key)
    this.states.set(key, { status: "saving" })
    const rollback = runOptions.optimistic?.()

    const mutation = this
    const promise: Promise<MutationResult<T, E>> = flow(function* () {
      try {
        const data: T = yield request()
        mutation.states.set(key, { status: "ok" })
        runOptions.onOk?.(data)
        return { status: "ok" as const, data }
      } catch (err: unknown) {
        const error = mutation.normalize(err)
        rollback?.()
        mutation.states.set(key, { status: "error", error })
        return { status: "error" as const, error }
      } finally {
        mutation.inflight.delete(key)
      }
    })()

    return promise
  }

  private normalize(err: unknown): E {
    if (this.options.normalizeError) return this.options.normalizeError(err)
    // Sound because the options type only makes normalizeError optional when
    // E is assignable from Error.
    return (err instanceof Error ? err : new Error(String(err))) as E
  }
}

/** Convenience constructor for the common `E = Error` case. */
export function createMutation(options: BaseMutationOptions = {}): Mutation<Error> {
  return new Mutation<Error>(options)
}
