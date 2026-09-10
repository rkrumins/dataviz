/**
 * What the canvas says about what the user just did.
 *
 * Six notifications used to say the same generic thing every time — three
 * different containers, three identical "Child entities loaded" — and their
 * in-progress strings were system vocabulary ("Loading aggregated edges",
 * "Computing layer assignments"). A message that cannot name its subject is
 * noise, and the Data loads panel is a column of it.
 *
 * The building lives here rather than inline in ContextViewCanvas so every
 * case can be read and tested without mounting the canvas. Two rules run
 * through all of it: numbers are localised, and the words entity, edge,
 * hydration and aggregated never reach a user.
 */
import type { EntityTypeSchema } from '@/types/schema'
import type { ChildLoadSummary } from '@/hooks/useGraphHydration'

const n = (value: number) => value.toLocaleString()

/**
 * The noun for a page of children, from the ontology — "5 datasets", not
 * "5 entities". A page that mixes types (or carries one the schema doesn't
 * declare) has no honest single noun, so it falls back to items.
 */
export function childNoun(
  count: number,
  childTypes: string[],
  entityTypes?: EntityTypeSchema[],
): string {
  const only = childTypes.length === 1
    ? entityTypes?.find(t => t.id === childTypes[0])
    : undefined
  if (!only) return count === 1 ? 'item' : 'items'
  return count === 1 ? only.name.toLowerCase() : only.pluralName.toLowerCase()
}

/** In progress: the container the user clicked, by name. */
export function loadingChildrenMessage(parentLabel: string): string {
  return `Loading ${parentLabel}…`
}

/**
 * Done. Page 1 states what arrived; every page after it says "more" and where
 * the user has got to, because "5 datasets" for the fourth time running says
 * nothing about progress.
 */
export function childLoadMessage(
  summary: ChildLoadSummary,
  entityTypes?: EntityTypeSchema[],
): string {
  const { parentLabel, arrived, offset, total, childTypes } = summary
  if (arrived === 0) return `${parentLabel} · nothing more to load`
  if (offset > 0) {
    return total === undefined
      ? `${parentLabel} · ${n(arrived)} more`
      : `${parentLabel} · ${n(arrived)} more (${n(offset + arrived)} of ${n(total)})`
  }
  return `${parentLabel} · ${n(arrived)} ${childNoun(arrived, childTypes, entityTypes)}`
}

/** The view is named in the message because the user chose it by name. */
export function openingViewMessage(viewName?: string): string {
  return viewName ? `Opening “${viewName}”…` : 'Opening this view…'
}

export function openedViewMessage(viewName: string | undefined, count: number): string {
  return viewName
    ? `Opened “${viewName}” · ${n(count)} items`
    : `Opened this view · ${n(count)} items`
}

/** The RAW edge fetch — the set `lineageEdges` filters containment out of.
 *  It carries structural relationships as well as flows, so the covering
 *  word is the only honest one here. */
export function connectionsLoadedMessage(count: number): string {
  return `Relationships · ${n(count)}`
}

export function layersPlacedMessage(placed: number, layers: number, unplaced: number): string {
  const base = `Placed ${n(placed)} items across ${n(layers)} layers`
  return unplaced > 0 ? `${base} · ${n(unplaced)} unplaced` : base
}
