/**
 * The model's own answers, computed once per model (2026-08-22).
 *
 * `ancestorsOf` and `subtreeOf` are pure functions of the containment
 * model — and the model does not change when the reader expands a
 * container, switches density, or types in the filter. They used to be
 * cached INSIDE `buildFocusLayout`, so every one of those runs paid for
 * them again: 98 ms and 66 ms respectively over one measured interaction
 * window on the wide table.
 *
 * The caches now hang off the model itself in a `WeakMap`, so a new walk
 * model gets fresh answers and an old one's are collected with it. No
 * invalidation to get wrong: a different model is a different key.
 */
interface ContainmentNode {
  parent: string | null
  children: readonly string[]
}
type Model = ReadonlyMap<string, ContainmentNode>

interface ModelCaches {
  ancestors: Map<string, string[]>
  subtrees: Map<string, Set<string>>
}

const CACHES = new WeakMap<object, ModelCaches>()

function cachesFor(model: Model): ModelCaches {
  const key = model as unknown as object
  let hit = CACHES.get(key)
  if (!hit) {
    hit = { ancestors: new Map(), subtrees: new Map() }
    CACHES.set(key, hit)
  }
  return hit
}

/** Containment ancestors of `urn`, OUTERMOST FIRST. Cycles terminate. */
export function ancestorsFor(model: Model, urn: string): string[] {
  const cache = cachesFor(model).ancestors
  const hit = cache.get(urn)
  if (hit) return hit
  const out: string[] = []
  const seen = new Set<string>([urn])
  let cursor = model.get(urn)?.parent ?? null
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    out.push(cursor)
    cursor = model.get(cursor)?.parent ?? null
  }
  out.reverse()
  cache.set(urn, out)
  return out
}

/** `urn` plus every containment descendant IN THE MODEL. Cycles terminate. */
export function subtreeFor(model: Model, urn: string): Set<string> {
  const cache = cachesFor(model).subtrees
  const hit = cache.get(urn)
  if (hit) return hit
  const out = new Set<string>()
  const stack = [urn]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (out.has(next) || !model.has(next)) continue
    out.add(next)
    for (const child of model.get(next)!.children) stack.push(child)
  }
  cache.set(urn, out)
  return out
}
