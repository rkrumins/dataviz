/**
 * magicMap — one-click mapping of top-level entities onto layers by name.
 *
 * The common real-world shape is a physical graph whose roots are ALREADY named
 * like the layers the user just defined ("Staging" → Staging, "src" → Source).
 * Doing that by hand is N drag gestures; this proposes the whole mapping in one
 * pass and the user accepts it in a review sheet.
 *
 * Pure + dependency-free on purpose: no fuzzy-search library exists in the repo
 * and adding one for ~60 lines of matching would be unjustified. Matching is
 * conservative — anything ambiguous is dropped rather than guessed, because a
 * wrong bulk placement is far more expensive than a missing suggestion.
 */

import type { ViewLayerConfig } from '@/types/schema'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MagicMapCandidate {
    urn: string
    name: string
    type: string
}

export type MagicMapConfidence = 'high' | 'medium' | 'low'

export interface MagicMapSuggestion {
    urn: string
    name: string
    type: string
    layerId: string
    layerName: string
    confidence: MagicMapConfidence
    /** Human-readable justification shown in the review sheet. */
    reason: string
}

type MatchableLayer = Pick<ViewLayerConfig, 'id' | 'name' | 'entityTypes'>

// ─── Normalization ──────────────────────────────────────────────────────────

/** "StagingArea_v2" / "staging-area" / "staging.area" → ["staging", "area"] */
export function normalizeTokens(raw: string): string[] {
    return raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
        .replace(/[-_./\\]+/g, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(' ')
        .map(singularize)
        .filter(Boolean)
}

/** Naive singularization — enough to match "Applications" to an "Application" layer. */
function singularize(token: string): string {
    if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2)
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
    return token
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
    if (a.size === 0) return false
    for (const t of a) if (!b.has(t)) return false
    return true
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let shared = 0
    for (const t of a) if (b.has(t)) shared++
    return shared / (a.size + b.size - shared)
}

// ─── Scoring ────────────────────────────────────────────────────────────────

const MIN_SCORE = 0.4
/** A tie between two layers at the top score is ambiguous → no suggestion. */
const TIE_EPSILON = 1e-9

interface Scored {
    score: number
    reason: string
}

function scorePair(entity: MagicMapCandidate, layer: MatchableLayer): Scored {
    const entityTokens = normalizeTokens(entity.name)
    const layerTokens = normalizeTokens(layer.name)
    const entityKey = entityTokens.join(' ')
    const layerKey = layerTokens.join(' ')

    if (!entityKey || !layerKey) return { score: 0, reason: '' }

    const eSet = new Set(entityTokens)
    const lSet = new Set(layerTokens)

    let score = 0
    let reason = ''

    if (entityKey === layerKey) {
        score = 1
        reason = `Name matches layer "${layer.name}"`
    } else if (isSubset(lSet, eSet) || isSubset(eSet, lSet)) {
        score = 0.8
        reason = `Name contains every word of "${layer.name}"`
    } else {
        const j = jaccard(eSet, lSet)
        if (j >= 0.5) {
            score = 0.6
            reason = `Name overlaps "${layer.name}"`
        } else if (
            (entityKey.includes(layerKey) && layerKey.length >= 4) ||
            (layerKey.includes(entityKey) && entityKey.length >= 4)
        ) {
            score = 0.4
            reason = `Name resembles "${layer.name}"`
        }
    }

    if (score === 0) return { score: 0, reason: '' }

    // A layer that already declares this entity's type is a stronger fit.
    if (layer.entityTypes?.some(t => t.toLowerCase() === entity.type.toLowerCase())) {
        score += 0.2
        reason += ` · layer includes ${entity.type}`
    }

    return { score, reason }
}

// ─── Public API ─────────────────────────────────────────────────────────────

function toConfidence(score: number): MagicMapConfidence {
    if (score >= 0.8) return 'high'
    if (score >= 0.6) return 'medium'
    return 'low'
}

/**
 * Propose a layer for each candidate entity. Callers pass only the entities
 * that are still UNASSIGNED — an existing placement is never overridden.
 * Entities whose two best layers tie are skipped (ambiguous, not guessable).
 */
export function suggestLayerMappings(
    entities: MagicMapCandidate[],
    layers: MatchableLayer[],
): MagicMapSuggestion[] {
    if (layers.length === 0) return []

    const suggestions: MagicMapSuggestion[] = []

    for (const entity of entities) {
        let best: { layer: MatchableLayer; scored: Scored } | null = null
        let runnerUpScore = 0

        for (const layer of layers) {
            const scored = scorePair(entity, layer)
            if (scored.score <= 0) continue
            if (!best || scored.score > best.scored.score) {
                if (best) runnerUpScore = best.scored.score
                best = { layer, scored }
            } else if (scored.score > runnerUpScore) {
                runnerUpScore = scored.score
            }
        }

        if (!best || best.scored.score < MIN_SCORE) continue
        // Ambiguous: two layers fit equally well — let the human decide.
        if (Math.abs(best.scored.score - runnerUpScore) < TIE_EPSILON && runnerUpScore > 0) continue

        suggestions.push({
            urn: entity.urn,
            name: entity.name,
            type: entity.type,
            layerId: best.layer.id,
            layerName: best.layer.name,
            confidence: toConfidence(best.scored.score),
            reason: best.scored.reason,
        })
    }

    return suggestions
}
