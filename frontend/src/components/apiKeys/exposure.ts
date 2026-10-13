/**
 * How far a key would reach if it leaked, before it exists.
 *
 * Modelled on the invite wizard's exposure meter: a meter, not a score —
 * each term is one thing that widens what a stolen copy could do, the weights
 * are ordinal rather than a risk model, and the band never stands alone: the
 * reasons say which choices put it there, in the words of the choice.
 */
import type { ApiKeyPermissions } from '@/services/apiKeyService'
import type { ResourceMode } from './apiKeyDraft'

export type ExposureBand = 'low' | 'moderate' | 'high'

export interface Exposure {
    /** 0–100, for the meter's fill. */
    pct: number
    band: ExposureBand
    label: 'Low' | 'Moderate' | 'High'
    /** What widens it, worst first. */
    reasons: string[]
    /** What keeps it in check. */
    limits: string[]
}

const LABEL = { low: 'Low', moderate: 'Moderate', high: 'High' } as const

export function keyExposure({ permissions: p, resourceMode, lifetimeDays, cidrs }: {
    permissions: ApiKeyPermissions
    resourceMode: ResourceMode
    /** null: it never expires. */
    lifetimeDays: number | null
    cidrs: string[]
}): Exposure {
    let n = 0
    const reasons: string[] = []
    const limits: string[] = []

    if (resourceMode === 'all') {
        n += 30
        reasons.push('Reaches everything you can access, including what you gain later')
    } else if (resourceMode === 'workspaces') {
        n += 15
        reasons.push('Reaches whole workspaces, including what is added to them later')
    } else {
        n += 5
        limits.push('Only the views and data sources you picked')
    }

    if (p.data === 'write') {
        n += 15
        reasons.push('Can change data')
    }
    if (p.views === 'write') {
        n += 10
        reasons.push('Can change views')
    }
    if (p.publish) {
        n += 15
        reasons.push('Can publish views to everyone')
    }
    if (p.data !== 'write' && p.views !== 'write') limits.push('Read-only')

    if (lifetimeDays === null) {
        n += 25
        reasons.push('Never expires')
    } else if (lifetimeDays > 90) {
        n += 15
        reasons.push(`Long-lived: ${lifetimeDays} days`)
    } else if (lifetimeDays > 30) {
        n += 8
        limits.push(`Expires in ${lifetimeDays} days`)
    } else {
        limits.push(`Expires in ${lifetimeDays} day${lifetimeDays === 1 ? '' : 's'}`)
    }

    if (cidrs.length === 0) {
        n += 10
        reasons.push('Works from any network')
    } else {
        limits.push(`Only from ${cidrs.length} network${cidrs.length === 1 ? '' : 's'}`)
    }

    const pct = Math.min(100, n)
    const band: ExposureBand = pct >= 60 ? 'high' : pct >= 30 ? 'moderate' : 'low'
    return { pct, band, label: LABEL[band], reasons, limits }
}
