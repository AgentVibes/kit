import { Observer } from "mobx-react-lite"
import type { ReactElement, ReactNode } from "react"
import { match } from "ts-pattern"
import type { Query } from "../../resource/query.js"

export type QueryViewProps<T, E = Error> = {
  query: Query<T, E>
  /** Nothing requested yet (or gated off by `enabled`). Falls back to `loading`. */
  idle?: () => ReactNode
  /** First load, nothing to show yet. */
  loading: () => ReactNode
  /** Failed with nothing to fall back on. `retry` forces a refetch. */
  error: (args: { error: E; revalidating: boolean; retry: () => void }) => ReactNode
  /**
   * Data present. `revalidating` is true while a refetch is in flight (shimmer
   * or refresh dot), `stale` once the data is past `staleTimeMs`, and `error`
   * is set when the last refetch failed but the old data is still shown.
   */
  ready: (args: { value: T; revalidating: boolean; stale: boolean; error?: E }) => ReactNode
}

/**
 * Renders the four async states of a Query distinctly — the canonical
 * implementation of the house four-state rule.
 *
 * The body runs inside `<Observer>`, so a state change re-renders this view
 * alone and never the parent.
 */
export function QueryView<T, E = Error>(props: QueryViewProps<T, E>): ReactElement {
  const { query, idle, loading, error, ready } = props

  return (
    <Observer>
      {() => (
        <>
          {match(query.viewState)
            .with({ status: "idle" }, () => (idle ?? loading)())
            .with({ status: "loading" }, () => loading())
            .with({ status: "error" }, (view) =>
              error({
                error: view.error,
                revalidating: view.revalidating,
                retry: () => void query.invalidate(),
              }),
            )
            .with({ status: "ready" }, (view) => ready(view))
            .exhaustive()}
        </>
      )}
    </Observer>
  )
}
