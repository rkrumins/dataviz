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
 *    friendly `displayName` versus the fully-qualified technical identity
 *    (`qualifiedName`, falling back to the URN), both of which are populated on
 *    every node already.
 * 2. The same entity could show two different names on one screen: the drawer
 *    tried `businessLabel` first while the context-view row tried `label` first,
 *    so a curated override won in one place and lost in the other.
 *
 * Both are settled by routing every name decision through the two functions
 * below rather than re-deriving the precedence at each render site.
 *
 * REVEAL, DON'T SWAP
 * Technical mode does not merely substitute one string for another — on real
 * data `qualifiedName` is frequently identical to `displayName` (some loaders
 * set it from the name), and a swap for an identical string is invisible. So
 * technical mode keeps the name people recognise and *adds* the technical
 * identity as a second line, choosing the first value that says something the
 * name does not.
 */
import type { PersonaMode } from '@/store/persona'

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

/**
 * The quiet second line technical mode reveals: the entity's technical identity,
 * or undefined when there is nothing to add.
 *
 * `qualifiedName` first because it is the fully-qualified path a data engineer
 * asks for; the URN when the qualified name is absent or is just the display
 * name again. Returns undefined whenever the value would repeat the name already
 * on screen, so a row never renders the same string twice.
 */
export function technicalSubtitle(
    data: EntityNameFields | null | undefined,
    mode: PersonaMode,
): string | undefined {
    if (mode !== 'technical') return undefined
    const d = data ?? {}
    const name = resolveEntityName(d, mode)
    for (const candidate of [text(d.qualifiedName), text(d.urn)]) {
        if (candidate && candidate !== name) return candidate
    }
    return undefined
}
