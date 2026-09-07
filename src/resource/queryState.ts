import { match } from "ts-pattern";

/**
 * Is a request in flight right now? Orthogonal to `status` on purpose: "we
 * have data" and "we are fetching" are independent axes, and only two axes can
 * express stale-while-revalidate (`success` + `fetching`). A flat union cannot.
 */
export type FetchActivity = "idle" | "fetching";

/**
 * The full state of a Query.
 *
 * - `idle` — nothing has been requested yet (or the query is gated off by
 *   `enabled`). This is the start state.
 * - `pending` — requested, nothing to show yet.
 * - `success` — data present.
 * - `error` — failed with nothing to fall back on.
 * - `stale-error` — a refetch failed but the previous data is still shown.
 */
export type QueryState<T, E = Error> =
  | { status: "idle" }
  | { status: "pending"; fetchActivity: FetchActivity }
  | { status: "success"; data: T; dataUpdatedAt: number; fetchActivity: FetchActivity }
  | { status: "error"; error: E; fetchActivity: FetchActivity }
  | {
      status: "stale-error";
      data: T;
      dataUpdatedAt: number;
      error: E;
      fetchActivity: FetchActivity;
    };

/**
 * The four arms a UI actually renders, derived from the five-arm QueryState.
 * `success` and `stale-error` both land on `ready` — the difference is carried
 * by `stale` and the readable `error`, not by a separate branch every caller
 * would have to remember.
 *
 * `Query.viewState` and `Query.resource` are both defined through this, so the
 * component-facing projection and the Resource projection cannot drift apart.
 */
export type QueryViewState<T, E = Error> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: E; revalidating: boolean }
  | { status: "ready"; value: T; revalidating: boolean; stale: boolean; error?: E };

export function toQueryViewState<T, E>(
  state: QueryState<T, E>,
  stale: boolean,
): QueryViewState<T, E> {
  return match(state)
    .with({ status: "idle" }, (): QueryViewState<T, E> => ({ status: "idle" }))
    .with({ status: "pending" }, (): QueryViewState<T, E> => ({ status: "loading" }))
    .with(
      { status: "success" },
      (s): QueryViewState<T, E> => ({
        status: "ready",
        value: s.data,
        revalidating: s.fetchActivity === "fetching",
        stale,
      }),
    )
    .with(
      { status: "stale-error" },
      (s): QueryViewState<T, E> => ({
        status: "ready",
        value: s.data,
        revalidating: s.fetchActivity === "fetching",
        stale: true,
        error: s.error,
      }),
    )
    .with(
      { status: "error" },
      (s): QueryViewState<T, E> => ({
        status: "error",
        error: s.error,
        revalidating: s.fetchActivity === "fetching",
      }),
    )
    .exhaustive();
}
