/**
 * drawerLayout — which sections the entity drawer shows, in what order, for
 * each view; and which properties it features at the top.
 *
 * The Technical view shows every section, in the order it always has. The
 * Business view opens on the entity at a glance — its ID, its description and
 * the properties that matter — then its properties, classifications and
 * lineage; the identifier block, the raw details, where it sits and its
 * history wait to be switched on. Either view can be reordered and trimmed
 * from the drawer's Customize panel, and keeps its own choice (preferences).
 *
 * Pure: the drawer and the Customize panel read and write through these.
 */
import type { PersonaMode } from '@/store/persona'
import type { DrawerLayout, DrawerSectionId } from '@/store/preferences'
import type { EntityFieldDefinition } from '@/types/schema'
import { readSchemaField } from '@/lib/nodeFields'
import { humanizeKey } from '@/components/ui/ValueView'

export const DRAWER_SECTIONS: readonly DrawerSectionId[] = [
  'overview', 'identifier', 'details', 'relationship', 'properties', 'classifications', 'lineage', 'history',
]

export const SECTION_LABELS: Record<DrawerSectionId, string> = {
  overview: 'At a glance',
  identifier: 'Identifier',
  details: 'Details',
  relationship: 'Relationship',
  properties: 'Properties',
  classifications: 'Classifications',
  lineage: 'Lineage',
  history: 'History',
}

const DEFAULTS: Record<PersonaMode, DrawerLayout> = {
  technical: {
    order: ['identifier', 'details', 'relationship', 'properties', 'classifications', 'lineage', 'history', 'overview'],
    hidden: ['overview'],
  },
  business: {
    order: ['overview', 'properties', 'classifications', 'lineage', 'identifier', 'details', 'relationship', 'history'],
    hidden: ['identifier', 'details', 'relationship', 'history'],
  },
}

export function defaultLayout(mode: PersonaMode): DrawerLayout {
  return DEFAULTS[mode]
}

const KNOWN = new Set<DrawerSectionId>(DRAWER_SECTIONS)
const unique = <T,>(xs: T[]): T[] => [...new Set(xs)]

/**
 * A stored layout made whole: ids it doesn't know are dropped, and a section
 * it never heard of (one added since it was saved) arrives as the view's
 * default has it — at the end, shown or hidden.
 */
export function resolveLayout(stored: DrawerLayout | null | undefined, mode: PersonaMode): DrawerLayout {
  const base = DEFAULTS[mode]
  if (!stored) return base
  const order = unique(stored.order.filter((id) => KNOWN.has(id)))
  const named = new Set<DrawerSectionId>([...order, ...stored.hidden])
  for (const id of base.order) if (!order.includes(id)) order.push(id)
  const hidden = unique([
    ...stored.hidden.filter((id) => KNOWN.has(id)),
    ...base.hidden.filter((id) => !named.has(id)),
  ])
  return { order, hidden }
}

/** The sections shown, in order. */
export function shownSections(layout: DrawerLayout): DrawerSectionId[] {
  const hidden = new Set(layout.hidden)
  return layout.order.filter((id) => !hidden.has(id))
}

/** One step up (-1) or down (1); the same layout at either end. */
export function moveSection(layout: DrawerLayout, id: DrawerSectionId, by: -1 | 1): DrawerLayout {
  const i = layout.order.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= layout.order.length) return layout
  const order = [...layout.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...layout, order }
}

export function setSectionShown(layout: DrawerLayout, id: DrawerSectionId, shown: boolean): DrawerLayout {
  const hidden = layout.hidden.filter((h) => h !== id)
  return { ...layout, hidden: shown ? hidden : [...hidden, id] }
}

export function isDefaultLayout(layout: DrawerLayout, mode: PersonaMode): boolean {
  const base = DEFAULTS[mode]
  return layout.order.join() === base.order.join()
    && [...layout.hidden].sort().join() === [...base.hidden].sort().join()
}

// ── Featured properties ──

/** Shown in the drawer's own header and description already. */
const NOT_FEATURED = new Set(['name', 'displayName', 'label', 'description', 'businessLabel'])

/** What an entity type features before anyone chooses: the fields its schema
 *  marks for the details panel, in its order, then an owner. */
export function defaultFeatured(fields: readonly EntityFieldDefinition[] | undefined): string[] {
  const panel = [...(fields ?? [])]
    .filter((f) => f.showInPanel && !NOT_FEATURED.has(f.id))
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((f) => f.id)
  return unique([...panel, 'owner'])
}

export interface FeaturedProperty {
  key: string
  value: unknown
}

/**
 * The properties featured for one entity. A type's own choice (pinned) is
 * shown whole — a pinned property this entity lacks reads "Not set", which is
 * itself worth knowing — while the defaults show only what the entity has.
 */
export function resolveFeatured(
  pinned: readonly string[] | undefined,
  fields: readonly EntityFieldDefinition[] | undefined,
  data: Record<string, unknown>,
): FeaturedProperty[] {
  const read = (key: string) => readSchemaField(data, key)
  const present = (v: unknown) => v !== undefined && v !== null && v !== ''
  if (pinned) return pinned.map((key) => ({ key, value: read(key) }))
  return defaultFeatured(fields)
    .map((key) => ({ key, value: read(key) }))
    .filter((p) => present(p.value))
}

/** What can be featured for one entity: its own properties, and its type's
 *  fields it has a value for — never the name or description, shown already. */
export function featurableKeys(
  fields: readonly EntityFieldDefinition[] | undefined,
  data: Record<string, unknown>,
  userProps: Record<string, unknown>,
): string[] {
  const keys = new Set(Object.keys(userProps).filter((k) => !NOT_FEATURED.has(k)))
  for (const f of fields ?? []) {
    if (NOT_FEATURED.has(f.id)) continue
    const v = readSchemaField(data, f.id)
    if (v !== undefined && v !== null && v !== '') keys.add(f.id)
  }
  return [...keys]
}

/** A featured property's name: its type's own name for the field (`SLA`), or
 *  the key made readable (`retention_days` → `Retention days`). */
export function propertyLabel(key: string, fields: readonly EntityFieldDefinition[] | undefined): string {
  return fields?.find((f) => f.id === key)?.name || humanizeKey(key)
}
