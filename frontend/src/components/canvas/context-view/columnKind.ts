/**
 * What KIND of column a layer is — read off its config, no request — so its header can say what
 * adding or dropping there does (the graph is the truth; a view is a lens over it):
 *
 *   • MAPPED    — the column IS an entity (`anchorUrn`, loaded and not claimed by another column):
 *                 its rows are that entity's contents, and what is added or dropped in it goes
 *                 inside that entity — a data change.
 *   • BY TYPE   — the column is for entities of its types, or what its rules pick out: adding
 *                 creates one of its type; dropping on its header only arranges this view.
 *   • HAND-PICKED — none of those: it holds what someone placed there by hand, and arranging it
 *                 only changes this view.
 */
import { Link2, Pin, Shapes, type LucideIcon } from 'lucide-react'
import type { PersonaMode } from '@/store/persona'
import type { ViewLayerConfig } from '@/types/schema'

export type ColumnKind = 'mapped' | 'byType' | 'handPicked'

/** Each kind's glyph: a link to the entity, the shapes of a type, a pin for a hand's placing. */
export const COLUMN_KIND_ICON: Record<ColumnKind, LucideIcon> = { mapped: Link2, byType: Shapes, handPicked: Pin }

export function columnKind(
  layer: Pick<ViewLayerConfig, 'anchorUrn' | 'entityTypes' | 'rules'>,
  anchor: { resolved: boolean; issue?: 'missing' | 'duplicate' },
): ColumnKind {
  if (layer.anchorUrn && anchor.resolved && !anchor.issue) return 'mapped'
  if ((layer.entityTypes?.length ?? 0) > 0 || (layer.rules?.length ?? 0) > 0) return 'byType'
  return 'handPicked'
}

/** Why a column is not offered mapping to an entity — said on its card and in its menu. */
export const MAP_REFUSED_SEVERAL = 'Holds several top-level entities'
export const MAP_REFUSED_GROUPS = 'Holds groups'

/**
 * What mapping a column to an entity it offers — a view change. Mapped, a column's "+" and its
 * drops put things INSIDE its entity (data changes), so mapping is never offered where that would
 * change what someone already arranged without their noticing:
 *
 *   • map     — a hand-picked column holding at most one entity (or none): "Map this column to…".
 *   • mapped  — a column mapped to an entity: "Show ‹it› as a row" (`canUnmap`, while its entity is
 *               there to show) and "Map to another entity…".
 *   • refused — a hand-picked column of several roots, or of groups: says why.
 *   • null    — a column of types or rules: its rule would keep pulling every entity of its type
 *               into the entity's column (why the wizard's mapped columns have no types).
 */
export type MapOffer =
  | { kind: 'map' }
  | { kind: 'mapped'; canUnmap: boolean }
  | { kind: 'refused'; reason: string }

export function mapOffer(
  layer: Pick<ViewLayerConfig, 'anchorUrn' | 'entityTypes' | 'rules' | 'logicalNodes'>,
  ctx: { kind: ColumnKind; /** The column's top-level rows. */ roots: number },
): MapOffer | null {
  if (layer.anchorUrn) return { kind: 'mapped', canUnmap: ctx.kind === 'mapped' }
  if (ctx.kind !== 'handPicked') return null
  if ((layer.logicalNodes?.length ?? 0) > 0) return { kind: 'refused', reason: MAP_REFUSED_GROUPS }
  if (ctx.roots > 1) return { kind: 'refused', reason: MAP_REFUSED_SEVERAL }
  return { kind: 'map' }
}

/** "App", "App and Service", "App, Service and Job". */
const listOf = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
const aOrAn = (name: string) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`

export interface ColumnKindCopy {
  /** The mark's accessible name, and the card's heading: a few words. */
  label: string
  /** What the column is, and what adding or dropping in it does — plainly. */
  detail: string
  /** The Technical view's precise addition: the anchor's urn, the type ids, the rule count. */
  technical?: string
}

/** How a column of this kind is explained, in the reader's view. */
export function columnKindCopy(kind: ColumnKind, ctx: {
  persona: PersonaMode
  /** The entity a mapped column is, by the name the reader sees. */
  anchorName?: string
  anchorUrn?: string
  /** The column's types, by name (singular, and plural), and by id. */
  typeNames?: readonly string[]
  typePlurals?: readonly string[]
  typeIds?: readonly string[]
  ruleCount?: number
  /** Entities of other types placed in a by-type column by hand. */
  handPlaced?: number
}): ColumnKindCopy {
  const technical = ctx.persona === 'technical'
  if (kind === 'mapped') {
    const name = ctx.anchorName ?? 'its entity'
    return {
      label: `Mapped to ${name}`,
      detail: technical
        ? `This column is ${name}’s contents. Adding or dropping here puts things inside ${name} — changes the data.`
        : `This column is what’s inside ${name}. Adding or dropping here puts things inside ${name} — changes the data.`,
      technical: technical && ctx.anchorUrn ? ctx.anchorUrn : undefined,
    }
  }
  if (kind === 'byType') {
    const names = ctx.typeNames ?? []
    const rules = ctx.ruleCount ?? 0
    const byHand = ctx.handPlaced ?? 0
    // "A column for" rather than "every": in a curated view a child still follows its parent's column.
    const plurals = ctx.typePlurals ?? names.map((n) => `${n}s`)
    const shows = names.length > 0
      ? `A column for ${listOf(plurals)} — adding here creates ${names.length === 1 ? aOrAn(names[0]) : `one of them`}.`
      : 'Shows what its rules pick out.'
    const extra = byHand > 0 ? ` And ${byHand.toLocaleString()} placed here by hand.` : ''
    const parts = [
      (ctx.typeIds?.length ?? 0) > 0 ? `types: ${ctx.typeIds!.join(', ')}` : '',
      rules > 0 ? `${rules} rule${rules === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    return {
      label: names.length > 0 ? `By type: ${listOf(names)}` : 'By rule',
      detail: `${shows}${extra} Dropping on its header only changes this view.`,
      technical: technical && parts.length > 0 ? parts.join(' · ') : undefined,
    }
  }
  return {
    label: 'Hand-picked',
    detail: 'Entities placed here by hand. Arranging this column only changes this view.',
  }
}
