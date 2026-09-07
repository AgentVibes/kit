import { match } from "ts-pattern";

/**
 * Where an optimistically removed item was, so a failed request can put it
 * back. A closed union rather than `T | undefined` plus a sentinel index:
 * "the item was not in the list" is a state, not a missing value.
 */
export type Removal<T> = { kind: "removed"; at: number; item: T } | { kind: "absent" };

/** Take the item with `key` out of `list`, remembering where it was. */
export function takeOut<T>(
  list: readonly T[],
  keyOf: (item: T) => string,
  key: string,
): { list: T[]; removal: Removal<T> } {
  const at = list.findIndex((item) => keyOf(item) === key);
  const item = list[at];
  return {
    list: list.filter((candidate) => keyOf(candidate) !== key),
    removal: item === undefined ? { kind: "absent" } : { kind: "removed", at, item },
  };
}

/**
 * Put a removed item back where it came from.
 *
 * Two guards, both of which were real bugs before they were guards:
 *
 * - The index is clamped, because the list can have shrunk while the request
 *   was in flight (another page load, another move).
 * - `inserted: false` means the key is already present and nothing was
 *   spliced. The list is not merely mutated while a request is in flight, it
 *   can be REPLACED: a route transition re-runs the fetch, and the server
 *   still reports the item because the change never committed. Splicing on
 *   top of that mounted the same id twice — a React duplicate key, and any
 *   count tracked alongside it went one too high. Callers that track a count
 *   read `inserted` rather than assuming the restore happened.
 */
export function putBack<T>(
  list: readonly T[],
  removal: Removal<T>,
  keyOf: (item: T) => string,
): { list: T[]; inserted: boolean } {
  return match(removal)
    .with({ kind: "absent" }, () => ({ list: [...list], inserted: false }))
    .with({ kind: "removed" }, ({ at, item }) => {
      const key = keyOf(item);
      if (list.some((candidate) => keyOf(candidate) === key)) {
        return { list: [...list], inserted: false };
      }
      const next = [...list];
      next.splice(Math.min(at, next.length), 0, item);
      return { list: next, inserted: true };
    })
    .exhaustive();
}
