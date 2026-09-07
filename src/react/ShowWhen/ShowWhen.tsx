import type { ReactElement, ReactNode } from "react";
import { match } from "ts-pattern";

export type ShowWhenProps = {
  when: boolean;
  children: ReactNode;
  /** Rendered instead of `children` when `when` is false. Defaults to nothing. */
  fallback?: ReactNode;
};

/**
 * `{cond && <X/>}` renders the string "0" when `cond` is the number zero, and
 * reads as a bug the moment an else-branch appears. This says both branches.
 *
 * Not a reactive boundary: `when` is evaluated by the caller, so an `observer`
 * parent still re-renders when it changes. Use `QueryView` or an `observer`
 * child where the isolation matters.
 */
export function ShowWhen({ when, children, fallback = null }: ShowWhenProps): ReactElement {
  return (
    <>
      {match(when)
        .with(true, () => children)
        .with(false, () => fallback)
        .exhaustive()}
    </>
  );
}
