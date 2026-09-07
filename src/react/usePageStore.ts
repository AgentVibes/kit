import { type DependencyList, useEffect, useRef } from "react";

type Disposable = { dispose: () => void };

function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<Disposable>).dispose === "function"
  );
}

function depsEqual(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

type Holder<T> = {
  store: T;
  deps: DependencyList;
  refCount: number;
};

/**
 * Own a page-scoped MobX store for as long as the screen is mounted.
 *
 * Context-free by design: the factory closes over whatever the store needs
 * (`rootStore`, route params), and the store travels downwards through props.
 * There is no provider and no registry.
 *
 *   const store = usePageStore(() => new GalleryPageStore(rootStore, slug), [slug])
 *
 * Lifecycle:
 * - the factory runs once per distinct `deps`, held in a ref rather than
 *   `useMemo` so React's double render cannot create a second store;
 * - `store.dispose()` is called on unmount if the store has one;
 * - disposal is ref-counted and deferred to a microtask, which is what makes
 *   it StrictMode-safe. StrictMode's mount → unmount → mount happens inside
 *   one task, so the refcount is back at 1 before the microtask runs and the
 *   store the component is holding is never disposed underneath it.
 * - changing `deps` disposes the old store and builds a new one.
 */
export function usePageStore<T>(factory: () => T, deps: DependencyList): T {
  const ref = useRef<Holder<T> | null>(null);

  if (ref.current === null || !depsEqual(ref.current.deps, deps)) {
    ref.current = { store: factory(), deps, refCount: 0 };
  }
  const holder = ref.current;

  useEffect(() => {
    holder.refCount += 1;
    return () => {
      holder.refCount -= 1;
      if (holder.refCount > 0) return;
      queueMicrotask(() => {
        if (holder.refCount > 0) return;
        if (isDisposable(holder.store)) holder.store.dispose();
      });
    };
  }, [holder]);

  return holder.store;
}
