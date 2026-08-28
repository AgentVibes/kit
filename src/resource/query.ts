import { flow, makeAutoObservable } from "mobx"
import { match, P } from "ts-pattern"
import { warnDegraded } from "../diagnostics/diagnostics.js"
import { type QueryState, type QueryViewState, toQueryViewState } from "./queryState.js"
import { Resource } from "./resource.js"

const DEFAULT_THROTTLE_MS = 2000
const DEFAULT_STALE_TIME_MS = 30_000

type BaseQueryOptions<T> = {
  fetcher: () => Promise<T>
  /** Minimum gap between two `fetch()` calls. `invalidate()` ignores it. */
  throttleMs?: number
  /** How long data stays fresh. Drives `isStale` and focus refetch. */
  staleTimeMs?: number
  /** Poll period used by `enableRefetchInterval()`. */
  refetchIntervalMs?: number
  /**
   * Gate. While this returns false the query stays `idle` and neither
   * `fetch()` nor `invalidate()` runs — that is how a load waits for auth.
   * Read observable state in here if the answer can change.
   */
  enabled?: () => boolean
  debugLabel?: string
}

/**
 * `normalizeError` is optional only when the error type is Error, where the
 * built-in normalizer is correct. Any other E must supply one — otherwise the
 * query would claim a type it cannot produce.
 */
export type QueryOptions<T, E = Error> = BaseQueryOptions<T> &
  (E extends Error
    ? { normalizeError?: (err: unknown) => E }
    : { normalizeError: (err: unknown) => E })

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

type PrivateKeys =
  | "options"
  | "lastFetchStartedAt"
  | "inflightPromise"
  | "visibilityListener"
  | "refetchTimer"
  | "normalize"
  | "executeFetch"

/**
 * A TanStack-shaped async cell for MobX stores: stale-while-revalidate,
 * throttling, in-flight dedup, `invalidate()`, window-focus refetch and
 * interval polling — as one observable `state` a component can match on.
 *
 * Ported from Retouch4Me's `ObservableQuery`, with `idle`/`enabled`,
 * `.resource`, `refetchIntervalMs`, a typed error channel, and the
 * visibilitychange listener leak fixed.
 */
export class Query<T, E = Error> {
  state: QueryState<T, E> = { status: "idle" }

  private options: QueryOptions<T, E>
  private lastFetchStartedAt = 0
  private inflightPromise: Promise<void> | null = null
  private visibilityListener: (() => void) | null = null
  private refetchTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: QueryOptions<T, E>) {
    this.options = options
    makeAutoObservable<Query<T, E>, PrivateKeys>(this, {
      options: false,
      lastFetchStartedAt: false,
      inflightPromise: false,
      visibilityListener: false,
      refetchTimer: false,
      normalize: false,
      executeFetch: false,
      // These read something MobX cannot invalidate on — the wall clock, or a
      // caller-supplied predicate that may close over plain values. As plain
      // getters they are recomputed on every read and stay honest; as
      // computeds they would cache a `stale: false` forever.
      enabled: false,
      isStale: false,
      viewState: false,
      resource: false,
    })
  }

  get data(): T | null {
    return match(this.state)
      .with({ status: "success" }, ({ data }) => data)
      .with({ status: "stale-error" }, ({ data }) => data)
      .with({ status: "idle" }, () => null)
      .with({ status: "pending" }, () => null)
      .with({ status: "error" }, () => null)
      .exhaustive()
  }

  get hasData(): boolean {
    return this.state.status === "success" || this.state.status === "stale-error"
  }

  /** True whenever a request is in flight, including a revalidation. */
  get isFetching(): boolean {
    return this.state.status !== "idle" && this.state.fetchActivity === "fetching"
  }

  /** The first load only — a revalidation over existing data is not "loading". */
  get isLoading(): boolean {
    return this.state.status === "pending" && this.state.fetchActivity === "fetching"
  }

  get isStale(): boolean {
    return match(this.state)
      .with(
        { status: "success" },
        ({ dataUpdatedAt }) => Date.now() - dataUpdatedAt > this.staleTimeMs,
      )
      .with({ status: "stale-error" }, () => true)
      .with({ status: "idle" }, () => false)
      .with({ status: "pending" }, () => false)
      .with({ status: "error" }, () => false)
      .exhaustive()
  }

  get error(): E | null {
    return match(this.state)
      .with({ status: "error" }, ({ error }) => error)
      .with({ status: "stale-error" }, ({ error }) => error)
      .with({ status: "idle" }, () => null)
      .with({ status: "pending" }, () => null)
      .with({ status: "success" }, () => null)
      .exhaustive()
  }

  /** Whether the gate currently lets this query fetch. */
  get enabled(): boolean {
    return this.options.enabled?.() ?? true
  }

  /** The four render arms. `QueryView` matches on this. */
  get viewState(): QueryViewState<T, E> {
    return toQueryViewState(this.state, this.isStale)
  }

  /**
   * The five-arm state projected onto the park's `Resource<T, E>`, so the ~329
   * existing `Resource.` call sites can consume a Query without rewriting.
   * `stale-error` reads as `ready` — the error stays readable on `.error`.
   */
  get resource(): Resource<T, E> {
    return match(this.viewState)
      .with({ status: "idle" }, () => Resource.idle<T, E>())
      .with({ status: "loading" }, () => Resource.loading<T, E>())
      .with({ status: "ready" }, ({ value }) => Resource.ready<T, E>(value))
      .with({ status: "error" }, ({ error }) => Resource.error<T, E>(error))
      .exhaustive()
  }

  get staleTimeMs(): number {
    return this.options.staleTimeMs ?? DEFAULT_STALE_TIME_MS
  }

  get throttleMs(): number {
    return this.options.throttleMs ?? DEFAULT_THROTTLE_MS
  }

  /**
   * Fetch, throttled and deduplicated. Concurrent callers share one promise
   * and one request. Never rejects: a failed fetcher lands in `state`.
   */
  fetch(): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    if (this.inflightPromise) return this.inflightPromise

    const elapsed = Date.now() - this.lastFetchStartedAt
    if (this.lastFetchStartedAt > 0 && elapsed < this.throttleMs) return Promise.resolve()

    return this.executeFetch()
  }

  /** Force a refetch past the throttle. Still deduplicated, still gated. */
  invalidate(): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    if (this.inflightPromise) return this.inflightPromise
    return this.executeFetch()
  }

  /**
   * Refetch when the tab becomes visible again and the data is stale.
   * Returns a disposer; `dispose()` removes the listener as well — the donor
   * only nulled its handler and leaked the listener for the page's lifetime.
   */
  enableWindowFocusRefetch(): () => void {
    if (this.visibilityListener) return () => this.disableWindowFocusRefetch()

    if (typeof document === "undefined") {
      warnDegraded(
        "Query.enableWindowFocusRefetch",
        `no document in this environment; focus refetch is a no-op (${this.options.debugLabel ?? "query"})`,
      )
      return () => {}
    }

    const listener = () => {
      if (document.visibilityState === "visible" && this.isStale) void this.fetch()
    }
    this.visibilityListener = listener
    document.addEventListener("visibilitychange", listener)
    return () => this.disableWindowFocusRefetch()
  }

  disableWindowFocusRefetch(): void {
    if (!this.visibilityListener) return
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener)
    }
    this.visibilityListener = null
  }

  /**
   * Poll on `refetchIntervalMs` (or the override). Ticks call `invalidate()`,
   * not `fetch()`: an interval shorter than `throttleMs` would otherwise be
   * silently swallowed and look like a broken timer.
   */
  enableRefetchInterval(intervalMs?: number): () => void {
    const ms = intervalMs ?? this.options.refetchIntervalMs
    if (ms === undefined || ms <= 0) {
      warnDegraded(
        "Query.enableRefetchInterval",
        `no positive refetchIntervalMs; polling is a no-op (${this.options.debugLabel ?? "query"})`,
      )
      return () => {}
    }

    this.disableRefetchInterval()
    this.refetchTimer = setInterval(() => {
      void this.invalidate()
    }, ms)
    return () => this.disableRefetchInterval()
  }

  disableRefetchInterval(): void {
    if (this.refetchTimer === null) return
    clearInterval(this.refetchTimer)
    this.refetchTimer = null
  }

  /** Release every subscription this query owns. Safe to call twice. */
  dispose(): void {
    this.disableWindowFocusRefetch()
    this.disableRefetchInterval()
  }

  private normalize(err: unknown): E {
    if (this.options.normalizeError) return this.options.normalizeError(err)
    // Sound because the options type only makes normalizeError optional when
    // E is assignable from Error.
    return toError(err) as E
  }

  private executeFetch(): Promise<void> {
    this.lastFetchStartedAt = Date.now()
    this.state = match(this.state)
      .with(
        { status: "idle" },
        (): QueryState<T, E> => ({
          status: "pending",
          fetchActivity: "fetching",
        }),
      )
      .with(
        { status: P.union("pending", "success", "error", "stale-error") },
        (s): QueryState<T, E> => ({ ...s, fetchActivity: "fetching" }),
      )
      .exhaustive()

    const query = this
    const promise: Promise<void> = flow(function* () {
      try {
        const data: T = yield query.options.fetcher()
        query.state = {
          status: "success",
          data,
          dataUpdatedAt: Date.now(),
          fetchActivity: "idle",
        }
      } catch (err: unknown) {
        const error = query.normalize(err)
        // Keep whatever was on screen: a failed refetch degrades to
        // stale-error rather than blanking the view.
        const previous = match(query.state)
          .with({ status: "success" }, (s) => ({ data: s.data, dataUpdatedAt: s.dataUpdatedAt }))
          .with({ status: "stale-error" }, (s) => ({
            data: s.data,
            dataUpdatedAt: s.dataUpdatedAt,
          }))
          .with({ status: P.union("idle", "pending", "error") }, () => null)
          .exhaustive()

        query.state =
          previous === null
            ? { status: "error", error, fetchActivity: "idle" }
            : {
                status: "stale-error",
                data: previous.data,
                dataUpdatedAt: previous.dataUpdatedAt,
                error,
                fetchActivity: "idle",
              }
      } finally {
        query.inflightPromise = null
      }
    })()

    this.inflightPromise = promise
    return promise
  }
}

/** Convenience constructor for the common `E = Error` case. */
export function createQuery<T>(
  fetcher: () => Promise<T>,
  options: Omit<BaseQueryOptions<T>, "fetcher"> = {},
): Query<T, Error> {
  return new Query<T, Error>({ ...options, fetcher })
}
