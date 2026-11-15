# @agentvibes/kit

## 0.3.0

### Minor Changes

- 14ccb77: `warnDegraded` and `warnNotImplemented` now dedup per category and detail, not per category alone: the same category with a different detail reports again. A caller that passed a varying detail under one category now sees one event per distinct detail.

## 0.2.0

### Minor Changes

- 2a5b15e: Add `Mutation<E>` (keyed write state, optimistic edits with rollback, in-flight guard), `takeOut`/`putBack` optimistic list helpers, and `PagedQuery<T, C, E>` (cursor pagination with `loadMore`, `hasMore`, and an atomic `revalidate` that re-walks loaded pages).
