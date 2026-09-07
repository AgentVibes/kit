import { flow, makeAutoObservable } from "mobx";
import { match, P } from "ts-pattern";

/**
 * One page as the server reports it.
 *
 * `nextCursor: null` is the single termination signal, and synthesising it is
 * the adapter's job — the three real shapes in the park report the end
 * differently, and none of them should leak that into consumers:
 *
 * - opaque keyset cursor: `nextCursor` already arrives as `string | null`;
 * - page number plus `total`: `page * limit >= total ? null : page + 1`;
 * - offset plus `hasMore`: `hasMore ? nextOffset : null`.
 *
 * `total` is optional and passed straight through, because a consumer that
 * renders "42 of 310" would otherwise keep the parallel bookkeeping this
 * class exists to delete.
 */
export type PageResult<T, C> = {
  items: T[];
  nextCursor: C | null;
  total?: number;
};

/** The list as a whole: what a first paint renders. */
export type PagedListState<E = Error> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; error: E };

/**
 * One subordinate load — `loadMore()` or `revalidate()`. Both keep the list on
 * screen throughout, so neither has a `ready` arm: success is represented
 * structurally by the items that appeared, not by a flash state.
 */
export type PagedLoadState<E = Error> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: E };

type BasePagedQueryOptions<T, C> = {
  fetchPage: (cursor: C | undefined) => Promise<PageResult<T, C>>;
  /** Identity for cross-page dedup. Overlapping pages must never double-mount a row. */
  keyOf: (item: T) => string;
  debugLabel?: string;
};

/** Same rule as `QueryOptions`: only `E = Error` may omit the normalizer. */
export type PagedQueryOptions<T, C, E = Error> = BasePagedQueryOptions<T, C> &
  (E extends Error
    ? { normalizeError?: (err: unknown) => E }
    : { normalizeError: (err: unknown) => E });

type PrivateKeys = "options" | "normalize" | "appendUnique";

function listIsLoading<E>(state: PagedListState<E>): boolean {
  return match(state)
    .with({ status: "loading" }, () => true)
    .with({ status: P.union("idle", "ready", "error") }, () => false)
    .exhaustive();
}

function listIsReady<E>(state: PagedListState<E>): boolean {
  return match(state)
    .with({ status: "ready" }, () => true)
    .with({ status: P.union("idle", "loading", "error") }, () => false)
    .exhaustive();
}

function loadIsRunning<E>(state: PagedLoadState<E>): boolean {
  return match(state)
    .with({ status: "loading" }, () => true)
    .with({ status: P.union("idle", "error") }, () => false)
    .exhaustive();
}

/**
 * A cursor-paged list that accumulates: `load()` for the first page,
 * `loadMore()` for each one after, `revalidate()` to refresh what is already
 * loaded.
 *
 * Three independent axes, because they answer different questions and a UI
 * renders them in different places: `state` (does the list paint at all),
 * `pageLoad` (is the infinite-scroll sentinel working), `refresh` (is the
 * pull-to-refresh spinner turning).
 */
export class PagedQuery<T, C = string, E = Error> {
  items: T[] = [];
  state: PagedListState<E> = { status: "idle" };
  pageLoad: PagedLoadState<E> = { status: "idle" };
  refresh: PagedLoadState<E> = { status: "idle" };
  nextCursor: C | null = null;
  total: number | null = null;
  /** How many pages are loaded — the number `revalidate()` re-walks. */
  pageCount = 0;

  private options: PagedQueryOptions<T, C, E>;

  constructor(options: PagedQueryOptions<T, C, E>) {
    this.options = options;
    makeAutoObservable<PagedQuery<T, C, E>, PrivateKeys>(this, {
      options: false,
      normalize: false,
      appendUnique: false,
    });
  }

  /** Whether another page exists. */
  get hasMore(): boolean {
    return this.nextCursor !== null;
  }

  get isEmpty(): boolean {
    return this.state.status === "ready" && this.items.length === 0;
  }

  /**
   * Load the first page, discarding anything already accumulated. A second
   * call while the first is in flight is a no-op.
   */
  load(): Promise<void> {
    if (listIsLoading(this.state)) return Promise.resolve();

    this.state = { status: "loading" };
    this.pageLoad = { status: "idle" };
    this.refresh = { status: "idle" };

    const query = this;
    return flow(function* () {
      try {
        const page: PageResult<T, C> = yield query.options.fetchPage(undefined);
        query.items = query.appendUnique([], page.items);
        query.nextCursor = page.nextCursor;
        query.total = page.total ?? null;
        query.pageCount = 1;
        query.state = { status: "ready" };
      } catch (err: unknown) {
        query.state = { status: "error", error: query.normalize(err) };
      }
    })();
  }

  /**
   * Append the next page.
   *
   * No-ops unless the list is ready, no page is already in flight, and there
   * is a next cursor — the same three guards the donor needed, so a scroll
   * sentinel can call this freely on every intersection.
   *
   * A failed page leaves `nextCursor` untouched, so a retry re-requests the
   * page that failed rather than skipping it.
   */
  loadMore(): Promise<void> {
    const cursor = this.nextCursor;
    if (!listIsReady(this.state)) return Promise.resolve();
    if (loadIsRunning(this.pageLoad)) return Promise.resolve();
    if (cursor === null) return Promise.resolve();

    this.pageLoad = { status: "loading" };

    const query = this;
    return flow(function* () {
      try {
        const page: PageResult<T, C> = yield query.options.fetchPage(cursor);
        query.items = query.appendUnique(query.items, page.items);
        query.nextCursor = page.nextCursor;
        query.total = page.total ?? query.total;
        query.pageCount += 1;
        query.pageLoad = { status: "idle" };
      } catch (err: unknown) {
        query.pageLoad = { status: "error", error: query.normalize(err) };
      }
    })();
  }

  /**
   * Re-walk the pages already loaded, following the cursors the server hands
   * back, and swap the whole list in at the end.
   *
   * The walk builds into a scratch list and commits only if every page lands.
   * A failure part-way leaves the current items exactly as they were and
   * reports the error on `refresh` — the same choice `Query` makes with
   * `stale-error`: a failed refresh never blanks a list that is already on
   * screen.
   *
   * Note for keyset cursors: rows inserted since the first walk shift page
   * boundaries, so a re-walk can return slightly different membership than a
   * naive page-by-page diff would predict. That is inherent to keyset
   * pagination, not a defect here.
   */
  revalidate(): Promise<void> {
    if (this.pageCount === 0) return this.load();
    if (loadIsRunning(this.refresh)) return Promise.resolve();

    this.refresh = { status: "loading" };

    const query = this;
    const pages = this.pageCount;
    return flow(function* () {
      try {
        let cursor: C | undefined;
        let collected: T[] = [];
        let lastCursor: C | null = null;
        let lastTotal: number | undefined;
        let walked = 0;

        for (let index = 0; index < pages; index += 1) {
          const page: PageResult<T, C> = yield query.options.fetchPage(cursor);
          collected = query.appendUnique(collected, page.items);
          lastCursor = page.nextCursor;
          lastTotal = page.total;
          walked += 1;
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }

        query.items = collected;
        query.nextCursor = lastCursor;
        query.total = lastTotal ?? null;
        query.pageCount = walked;
        query.state = { status: "ready" };
        query.refresh = { status: "idle" };
      } catch (err: unknown) {
        query.refresh = { status: "error", error: query.normalize(err) };
      }
    })();
  }

  /** Back to the start: no items, no cursor, nothing loading. */
  reset(): void {
    this.items = [];
    this.state = { status: "idle" };
    this.pageLoad = { status: "idle" };
    this.refresh = { status: "idle" };
    this.nextCursor = null;
    this.total = null;
    this.pageCount = 0;
  }

  /**
   * Append, skipping keys already present. With a correct server this drops
   * nothing; it is here because a page that overlaps the one before it must
   * never reach React as two children with the same key.
   */
  private appendUnique(existing: readonly T[], incoming: readonly T[]): T[] {
    const seen = new Set(existing.map((item) => this.options.keyOf(item)));
    const next = [...existing];
    for (const item of incoming) {
      const key = this.options.keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(item);
    }
    return next;
  }

  private normalize(err: unknown): E {
    if (this.options.normalizeError) return this.options.normalizeError(err);
    // Sound because the options type only makes normalizeError optional when
    // E is assignable from Error.
    return (err instanceof Error ? err : new Error(String(err))) as E;
  }
}

/** Convenience constructor for the common `E = Error` case. */
export function createPagedQuery<T, C = string>(
  options: BasePagedQueryOptions<T, C>,
): PagedQuery<T, C, Error> {
  return new PagedQuery<T, C, Error>(options);
}
