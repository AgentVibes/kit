import type { Query } from "./query.js";

/**
 * A keyed set of Queries sharing one factory — the thing four sites in the
 * park hand-roll as a Map ("YYYY-MM" calendar pages, a job-info cache, a
 * per-media mutation map, three provider twins).
 *
 * The map itself is deliberately NOT observable: it is a memoization cache,
 * not state. That is what lets a component call `family.get(key)` during
 * render without mutating observable state mid-render. The Query instances it
 * hands out are observable as usual.
 */
export class QueryFamily<K extends string | number, T, E = Error> {
  private readonly queries = new Map<K, Query<T, E>>();
  private readonly create: (key: K) => Query<T, E>;

  constructor(create: (key: K) => Query<T, E>) {
    this.create = create;
  }

  /** The Query for `key`, created on first ask and memoized after. */
  get(key: K): Query<T, E> {
    const existing = this.queries.get(key);
    if (existing) return existing;

    const created = this.create(key);
    this.queries.set(key, created);
    return created;
  }

  /** The Query for `key` if one already exists — never creates. */
  peek(key: K): Query<T, E> | undefined {
    return this.queries.get(key);
  }

  has(key: K): boolean {
    return this.queries.has(key);
  }

  get size(): number {
    return this.queries.size;
  }

  keys(): K[] {
    return [...this.queries.keys()];
  }

  /** Dispose and forget one entry. Returns whether there was one. */
  remove(key: K): boolean {
    const existing = this.queries.get(key);
    if (!existing) return false;
    existing.dispose();
    this.queries.delete(key);
    return true;
  }

  /** Force a refetch of every live entry. */
  async invalidateAll(): Promise<void> {
    await Promise.all([...this.queries.values()].map((query) => query.invalidate()));
  }

  /** Dispose every entry and empty the family. */
  dispose(): void {
    for (const query of this.queries.values()) query.dispose();
    this.queries.clear();
  }
}
