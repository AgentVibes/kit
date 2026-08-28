/**
 * Resource<T, E> — the house union for async / heavy-data state.
 *
 * One discriminator for the whole park: `status`. The four copies this
 * replaces used `kind` (ppa, todoist, observatory), `status` (faceless,
 * tg-gallery) and `state` (Retouch4Me); `status` wins because Query uses it
 * too, so a store can hold both without two vocabularies.
 *
 * `loading.progress` is optional and absent means indeterminate. The donors
 * spelled indeterminate as `progress: -1`; a missing key says the same thing
 * without a magic number, and `Resource.loading()` still works unchanged.
 */
export type Resource<T, E = Error> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly progress?: number }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly error: E }

export const Resource = {
  idle<T, E = Error>(): Resource<T, E> {
    return { status: "idle" }
  },

  /** `progress` is 0..1. Omit it when the work has no measurable progress. */
  loading<T, E = Error>(progress?: number): Resource<T, E> {
    // The key is omitted rather than set to undefined: the package builds
    // under exactOptionalPropertyTypes, where those are different types.
    return progress === undefined ? { status: "loading" } : { status: "loading", progress }
  },

  ready<T, E = Error>(value: T): Resource<T, E> {
    return { status: "ready", value }
  },

  error<T, E = Error>(error: E): Resource<T, E> {
    return { status: "error", error }
  },
} as const
