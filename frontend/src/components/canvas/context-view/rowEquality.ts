/**
 * Value-equality for the flow overlay's computed arrays.
 *
 * `updateFlow` rebuilds `computedEdges` / `overflowBadges` / `proxyEdges` from
 * scratch on every measure pass, and a measure pass runs on scroll (per frame),
 * window resize, ResizeObserver, IntersectionObserver, MutationObserver and
 * selection change. Writing the fresh array unconditionally re-rendered EVERY
 * edge even when nothing had moved — O(edges) of wasted render per scroll frame,
 * which is why the canvas flickered harder the more was loaded onto it.
 * `setComputedRibbons` in the same file already guarded itself this way; the
 * three expensive writes never got the same treatment.
 *
 * A shallow per-row comparison is EXACT for these types, not an approximation:
 * every entry is a flat record of primitives plus a couple of string arrays
 * (`ComputedEdge.types`, `OverflowBadge.partnerIds`), which are compared
 * element-wise. Index-wise comparison is safe because the rows are rebuilt in a
 * deterministic order from the same traversal each pass.
 *
 * A NaN coordinate compares unequal and simply costs a rebuild — the guard is an
 * optimisation, so failing open is the right direction.
 */

function sameRow<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof T>
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (x === y) continue
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i]) return false
      }
      continue
    }
    return false
  }
  return true
}

/** True when two row arrays carry the same values in the same order. */
export function sameRows<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameRow(a[i], b[i])) return false
  }
  return true
}
