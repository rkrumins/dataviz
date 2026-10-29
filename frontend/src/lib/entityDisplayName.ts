/**
 * Entity naming — the one place the Business/Technical toggle turns into a name.
 *
 * WHY THIS EXISTS
 * Two problems met here.
 *
 * 1. The persona toggle was a no-op. Its only behavioural reader asked for
 *    `data.technicalLabel`, a field `toCanvasNode` never maps and the backend's
 *    `GraphNode` has no slot for — so both halves of the toggle resolved to the
 *    same string. The real business/technical axis in this product is the
 *    friendly `displayName` versus the entity's identifier, which every node
 *    already carries.
 * 2. The same entity could show two different names on one screen: the drawer
 *    tried `businessLabel` first while the context-view row tried `label` first,
 *    so a curated override won in one place and lost in the other.
 *
 * Both are settled by routing every name decision through the two functions
 * below rather than re-deriving the precedence at each render site.
 *
 * REVEAL, DON'T SWAP
 * Technical mode keeps the name people recognise and *adds* the entity's
 * identifier as a second line. Every row shows the same kind of value: the
 * identifier property its data source keys entities by (`id`, `identifier`, …,
 * set on the data source, its provider, its workspace or the platform), else
 * the URN. It used to show the qualified name where a loader set one that
 * differed from the name and the URN elsewhere, so one column mixed paths
 * with URNs.
 */
import type { PersonaMode } from '@/store/persona'
import { readSchemaField } from '@/lib/nodeFields'

/**
 * The name-bearing fields carried on a canvas node's `data` (see `toCanvasNode`).
 * Also matches the flat `EntityInstance` shape the graph node cards receive,
 * which spells the display name `name` rather than `label`.
 */
export interface EntityNameFields {
    label?: unknown
    name?: unknown
    businessLabel?: unknown
    qualifiedName?: unknown
    urn?: unknown
    properties?: unknown
}

/** A trimmed non-empty string, or undefined — every field here is optional and
 *  several loaders write `''` rather than omitting the key. */
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The name to render for an entity.
 *
 * Business mode prefers a curated `businessLabel` override; technical mode
 * wants the name the source system actually uses, so the override drops to last
 * resort rather than disappearing (a node whose only name IS the override must
 * still render something).
 */
export function resolveEntityName(
    data: EntityNameFields | null | undefined,
    mode: PersonaMode,
    fallback = '',
): string {
    const d = data ?? {}
    const business = text(d.businessLabel)
    const plain = text(d.label) ?? text(d.name)
    const chosen = mode === 'business' ? (business ?? plain) : (plain ?? business)
    return chosen ?? fallback
}

/** What technical mode reveals under a name: the property that identifies the entity, and its value. */
export interface TechnicalIdentity {
    /** `urn`, or the data source's identifier property (`id`, `identifier`, …). */
    property: string
    value: string
}

/** An identifier as text: a non-blank string, or a number written out. */
function identifierText(value: unknown): string | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)
}

/**
 * The quiet second line technical mode reveals: the entity's identifier. That is
 * the value of the identifier property its data source keys entities by
 * (`identityProperty`, from the data source's resolved mapping), or the URN when
 * the source keys by `urn`, maps nothing, or this entity has no value of its own.
 * `urn` stands in for data that carries none (a trace card drawn before its
 * node loaded).
 *
 * Undefined in business mode, when there is no identifier at all, and when the
 * identifier is `name`, the name the row already shows, so no row prints the
 * same string twice.
 */
export function technicalIdentity(
    data: EntityNameFields | null | undefined,
    mode: PersonaMode,
    { identityProperty, urn, name }: { identityProperty?: string | null; urn?: string; name: string },
): TechnicalIdentity | undefined {
    if (mode !== 'technical') return undefined
    const d = (data ?? {}) as Record<string, unknown>
    const property = identityProperty?.trim() || 'urn'
    const own = property === 'urn' ? undefined : identifierText(readSchemaField(d, property))
    const value = own ?? text(d.urn) ?? text(urn)
    if (value === undefined || value === name) return undefined
    return { property: own === undefined ? 'urn' : property, value }
}
