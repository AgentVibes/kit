import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Conditional class names with Tailwind conflict resolution: the last
 * conflicting utility wins, so `cn("p-2", override)` behaves the way a caller
 * passing `className` expects.
 *
 * `clsx` and `tailwind-merge` are optional peers — install them only if you
 * import this entry point.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
