# @agentvibes/kit

House runtime primitives for MobX applications. Four independent entry points, no runtime dependencies of its own — everything is a peer.

```sh
pnpm add @agentvibes/kit
```

| Entry point | What it gives you | Peers it needs |
| --- | --- | --- |
| `@agentvibes/kit/resource` | `Resource<T, E>`, `Query<T, E>`, `QueryFamily<K, T>`, `Mutation<E>`, `PagedQuery<T, C, E>` | `mobx`, `ts-pattern` |
| `@agentvibes/kit/react` | `usePageStore`, `QueryView`, `ShowWhen` | `react`, `mobx-react-lite`, `ts-pattern` |
| `@agentvibes/kit/diagnostics` | `warnDegraded`, `warnNotImplemented`, `warnUnexpected` | none |
| `@agentvibes/kit/cn` | `cn()` | `clsx`, `tailwind-merge` |

ESM only. Every peer except `mobx` and `ts-pattern` is optional — install what the entry points you import actually need.

## `/resource`

### `Resource<T, E>`

The union every consumer is forced to render completely.

```ts
import { Resource } from "@agentvibes/kit/resource"

type Resource<T, E = Error> =
  | { status: "idle" }
  | { status: "loading"; progress?: number }  // progress absent = indeterminate
  | { status: "ready"; value: T }
  | { status: "error"; error: E }

store.exportState = Resource.loading(0.4)
```

Use it for process-shaped work — renders, exports, file sync — where there is progress and no such thing as revalidation. For fetch-shaped work, use `Query`, which projects onto `Resource` through `.resource`.

### `Query<T, E>`

Stale-while-revalidate as one observable cell: throttling, in-flight dedup, `invalidate()`, focus refetch and interval polling, so a store never hand-rolls a `loading` boolean and a TTL guard again.

```ts
import { Query, createQuery } from "@agentvibes/kit/resource"

class BillingStore {
  quota = createQuery(() => api.fetchQuota(), {
    staleTimeMs: 30_000,
    refetchIntervalMs: 60_000,
    enabled: () => this.root.auth.isSignedIn,   // stays `idle` until it is
  })

  constructor(private root: RootStore) {
    makeAutoObservable(this)
    this.quota.enableWindowFocusRefetch()
  }

  dispose() {
    this.quota.dispose()
  }
}
```

The state has two independent axes, because one axis cannot express stale-while-revalidate:

```ts
type QueryState<T, E = Error> =
  | { status: "idle" }
  | { status: "pending";     fetchActivity: "idle" | "fetching" }
  | { status: "success";     data: T; dataUpdatedAt: number; fetchActivity: … }
  | { status: "error";       error: E; fetchActivity: … }
  | { status: "stale-error"; data: T; dataUpdatedAt: number; error: E; fetchActivity: … }
```

`success` + `fetching` is a revalidation; `stale-error` is "the refetch failed but the old data is still worth showing".

Readables: `data`, `hasData`, `error`, `isLoading` (first paint only), `isFetching` (any request in flight), `isStale`, `enabled`.

Projections, both derived from the same mapping so they cannot drift:

- `.viewState` — the four render arms (`idle` / `loading` / `error` / `ready`), what `QueryView` matches on.
- `.resource` — a `Resource<T, E>`. `pending` reads as `loading`; `stale-error` reads as `ready` with the error still on `.error`.

Options: `fetcher`, `throttleMs` (default 2000), `staleTimeMs` (default 30000), `refetchIntervalMs`, `enabled`, `normalizeError`, `debugLabel`. `normalizeError` is required only when `E` is not `Error`; the type enforces it.

Subscriptions are opt-in and each returns a disposer: `enableWindowFocusRefetch()`, `enableRefetchInterval()`. `dispose()` releases both.

`fetch()` is throttled; `invalidate()` skips the throttle. Both deduplicate — concurrent callers share one request and one promise — and both respect `enabled`. Neither ever rejects: a failed fetcher lands in the state.

### `QueryFamily<K, T, E>`

One factory, many keys, memoized.

```ts
const months = new QueryFamily<string, Day[]>((month) =>
  createQuery(() => api.fetchMonth(month)),
)

months.get("2026-08").fetch()
months.dispose()   // disposes every entry
```

The cache is deliberately not observable — it is memoization, not state — so `family.get(key)` is safe to call during render. Also: `peek`, `has`, `keys`, `size`, `remove`, `invalidateAll`.

### `Mutation<E>`

The write half of the four-state rule: one instance per store, one observable state per key, so two controls never share a spinner.

```ts
import { createMutation, takeOut, putBack } from "@agentvibes/kit/resource"

class GalleryStore {
  mutations = createMutation()

  deleteMedia(id: string) {
    return this.mutations.run(
      `deleteMedia:${id}`,
      () => api.deleteMedia(id),
      {
        optimistic: () => {
          const taken = takeOut(this.media, (m) => m.id, id)
          this.media = taken.list
          return () => {
            this.media = putBack(this.media, taken.removal, (m) => m.id).list
          }
        },
      },
    )
  }
}
```

Keys are the caller's and should be stable: `"createGallery"`, `` `deleteMedia:${id}` ``. Read one with `mutations.get(key)`, which returns `{status:"idle"|"saving"|"ok"|"error"}` — keys never run read as idle.

`run()` returns a three-armed result:

```ts
type MutationResult<T, E = Error> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E }
  | { status: "busy" }     // already in flight for this key; nothing was sent
```

**Concurrency:** a second `run()` on a key already in flight sends nothing and returns `busy`. That is the conservative default — a double-submitted write is usually a bug, not a queue. Queueing was the alternative; it belongs in the caller, where the ordering rules are actually known.

`optimistic` applies an edit immediately and returns its undo. The rollback runs if and only if the request fails — never on success, and never on `busy`, where nothing was applied.

`reset(key)` returns a key to idle, backing the "clear" affordance (dismiss an error, drop a lingering checkmark) and freeing accumulated per-item keys. It clears the badge only: it does not cancel a request, and the key stays guarded until that request lands, so a reset cannot open a double-submit hole. `isInFlight(key)` reads the real thing.

#### `takeOut` / `putBack`

Optimistic list edits, with the two guards that were bugs before they were guards. `takeOut` returns a `Removal<T>` — a closed union, because "the item was not in the list" is a state, not a missing value. `putBack` clamps the remembered index (the list can have shrunk while the request was in flight) and refuses to insert a key the list already contains (a route transition can *replace* the list with one the server still reports the item in; splicing on top mounted the same id twice). Callers that track a count read the returned `inserted` rather than assuming the restore happened.

### `PagedQuery<T, C, E>`

A cursor-paged list that accumulates.

```ts
import { createPagedQuery } from "@agentvibes/kit/resource"

const activity = createPagedQuery<ActivityEvent, string>({
  fetchPage: (cursor) => api.fetchActivity({ afterCursor: cursor }),
  keyOf: (event) => event.id,
})

await activity.load()       // first page
await activity.loadMore()   // append the next one
await activity.revalidate() // refresh the pages already loaded
```

A page is reported as `{ items, nextCursor: C | null, total?: number }`. `nextCursor: null` is the single termination signal, and synthesising it is the adapter's job — the three real shapes in the park each report the end differently:

| Server shape | Adapter writes |
| --- | --- |
| opaque keyset cursor | `nextCursor` already arrives as `string \| null` |
| page number plus `total` | `page * limit >= total ? null : page + 1` |
| offset plus `hasMore` | `hasMore ? nextOffset : null` |

Three independent axes, because a UI renders them in different places: `state` (`idle`/`loading`/`ready`/`error` — does the list paint at all), `pageLoad` (`idle`/`loading`/`error` — is the scroll sentinel working), `refresh` (same three — is the pull-to-refresh spinner turning). Plus `items`, `hasMore`, `isEmpty`, `total`, `pageCount`.

`loadMore()` no-ops unless the list is ready, no page is in flight, and a next cursor exists, so a scroll sentinel can call it on every intersection. A failed page leaves the cursor untouched, so a retry re-requests the page that failed rather than skipping it. Appends drop keys already loaded — an overlapping page must never reach React as two children with the same key.

`revalidate()` re-walks the pages already loaded, following the cursors the server hands back, and swaps the whole list in at the end. The walk builds into a scratch list and commits only if every page lands: a failure part-way leaves the current items exactly as they were and reports the error on `refresh`, the same choice `Query` makes with `stale-error`. Note that with a keyset cursor, rows inserted since the first walk shift page boundaries, so a re-walk can return slightly different membership — inherent to keyset pagination, not a defect.

## `/react`

### `usePageStore(factory, deps)`

Owns a page-scoped store for as long as the screen is mounted. Context-free by design: the factory closes over what the store needs, and the store travels downwards through props.

```tsx
function GalleryScreen({ slug }: { slug: string }) {
  const store = usePageStore(() => new GalleryPageStore(rootStore, slug), [slug])
  return <GalleryGrid store={store} />
}
```

- The factory runs once per distinct `deps` — held in a ref, not `useMemo`, because React's double render calls a `useMemo` factory twice and leaks the second store.
- `store.dispose()` is called on unmount, if the store has one.
- Disposal is ref-counted and deferred to a microtask, which is what makes it StrictMode-safe: mount → unmount → mount happens inside one task, so the store the component is holding is never disposed underneath it.
- Changing `deps` disposes the old store and builds a new one.

### `QueryView`

The canonical implementation of the four-state rule: every async state gets a distinct rendering, and the compiler will not let you skip one.

```tsx
<QueryView
  query={store.quota}
  idle={() => <SignInPrompt />}                       // optional; defaults to loading
  loading={() => <Spinner />}
  error={({ error, retry }) => <ErrorBanner message={error.message} onRetry={retry} />}
  ready={({ value, revalidating, stale, error }) => (
    <QuotaPanel quota={value} shimmer={revalidating} warning={error?.message} />
  )}
/>
```

The body runs inside `<Observer>`, so a state change re-renders this view alone and never the parent.

### `ShowWhen`

```tsx
<ShowWhen when={store.hasUnsaved} fallback={<Saved />}>
  <UnsavedBadge />
</ShowWhen>
```

Both branches are named, and a numeric zero cannot leak into the output the way `{count && <X/>}` lets it. Not a reactive boundary — `when` is evaluated by the caller.

## `/diagnostics`

The replacement for `// TODO`. A TODO never runs; these fire the first time the path is actually hit, dedup'd per category, greppable, and routable to a debug panel.

```ts
import { warnDegraded, warnNotImplemented, setDiagnosticHook } from "@agentvibes/kit/diagnostics"

warnDegraded("Chart.scale", "linear interpolation; cubic deferred")
warnNotImplemented("Export.pdf", "exists upstream, not ported yet")

setDiagnosticHook((event) => debugPanel.push(event))
```

`warnDegraded` and `warnNotImplemented` fire once per category; `warnUnexpected(category, detail, data?)` always fires, because a contradicted assumption matters every time. `resetDiagnostics()` clears the dedup set for tests.

## `/cn`

```ts
import { cn } from "@agentvibes/kit/cn"

cn("p-2", isActive && "bg-blue-500", className)
```

`clsx` plus `tailwind-merge`, so the last conflicting utility wins and a caller's `className` can actually override.

## Development

```sh
pnpm check     # typecheck + biome + vitest + build + publint + attw
```

CI runs the same command on every push and pull request. Releases go through changesets: `pnpm changeset`, then `pnpm release`.

## License

MIT
