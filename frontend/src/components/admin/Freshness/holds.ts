/**
 * holds — the operator hold on automatic rebuilds, as a fleet row sees it.
 *
 * Pure functions, no components: the chip, the drawer, the group header and
 * the page's rebuild confirmation all read one hold model, so "which control
 * releases this source" is answered in one place. Most restrictive wins across
 * fleet → provider → source, and the WIDEST scope is what a row names.
 */
import type {
    FleetHoldReason, FreshnessRow as FreshnessRowData, HoldKind, HoldScope, ReconcilePolicy,
} from '@/services/freshnessService'

/** Minutes/hours/days until a future instant, or null if it's already past. */
export function timeUntil(iso?: string | null): string | null {
    if (!iso) return null
    const ms = new Date(iso).getTime() - Date.now()
    if (Number.isNaN(ms) || ms <= 0) return null
    const mins = Math.round(ms / 60000)
    if (mins < 60) return `${mins}m`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.round(hours / 24)}d`
}

/** The one hold in force for a row: its scope (the control that will
 *  release it), its kind, and — for a pause — when it lapses. */
export interface RowHold {
    scope: HoldScope
    kind: HoldKind
    until: string | null
}

/**
 * The hold a row is under, as the server resolved it (most restrictive wins
 * across fleet → provider → source, and the WIDEST scope is what it names —
 * so a source held by its provider is not sent to a source-level Resume
 * that cannot release it). The fallback is for a backend that predates
 * ``heldBy``: the source's own two switches are the only hold it could have
 * reported. A source's stop IS its "rebuild automatically" toggle — there
 * is no second switch.
 */
export function rowHold(
    row: Pick<FreshnessRowData, 'autoReconcile' | 'pausedUntil' | 'heldBy' | 'heldKind' | 'heldUntil'>,
): RowHold | null {
    if (row.heldBy) {
        return { scope: row.heldBy, kind: row.heldKind ?? 'stopped', until: row.heldUntil ?? null }
    }
    if (row.autoReconcile === false) return { scope: 'source', kind: 'stopped', until: null }
    if (timeUntil(row.pausedUntil)) return { scope: 'source', kind: 'paused', until: row.pausedUntil ?? null }
    return null
}

/** The fleet-level hold, with the control that releases it. */
export interface FleetHold extends RowHold {
    scope: 'fleet'
    reason: FleetHoldReason
}

/**
 * The hold on the whole fleet, as the SERVER resolved it on the policy read:
 * the fleet row, ③ Act off, or an inherited ② Check off — the same answer
 * every gate gives, so the banner and the modal never contradict them. The
 * fallback is for a backend that predates ``heldBy`` on the policy: the
 * row's two stamps were the only fleet hold it could have reported.
 */
export function fleetHold(
    policy: Pick<ReconcilePolicy, 'heldBy' | 'heldKind' | 'heldUntil' | 'heldReason' | 'stoppedAt' | 'pausedUntil'> | null | undefined,
): FleetHold | null {
    if (!policy) return null
    if (policy.heldBy === 'fleet') {
        return {
            scope: 'fleet', kind: policy.heldKind ?? 'stopped', until: policy.heldUntil ?? null,
            reason: policy.heldReason ?? 'hold',
        }
    }
    if (policy.stoppedAt) return { scope: 'fleet', kind: 'stopped', until: null, reason: 'hold' }
    if (timeUntil(policy.pausedUntil)) {
        return { scope: 'fleet', kind: 'paused', until: policy.pausedUntil ?? null, reason: 'hold' }
    }
    return null
}

/** "Paused · 3h", "Stopped by provider", "Paused fleet-wide · 2d". The scope
 *  suffix is dropped when the hold is at ``own`` scope — a provider's own
 *  header does not say "by provider" about itself. Word AND icon carry the
 *  kind; the suffix carries the scope; never tone alone. */
export function holdLabel(hold: RowHold, own: HoldScope = 'source'): string {
    const left = hold.kind === 'paused' ? timeUntil(hold.until) : null
    const word = hold.kind === 'paused' ? 'Paused' : 'Stopped'
    const suffix = hold.scope === own || hold.scope === 'source'
        ? ''
        : hold.scope === 'fleet' ? ' fleet-wide' : ' by provider'
    return `${word}${suffix}${left ? ` · ${left}` : ''}`
}

/** The tooltip: what is holding the source and, more importantly, WHERE it
 *  is released — the whole reason the chip names a scope. */
export function holdTitle(hold: RowHold): string {
    const verb = hold.kind === 'paused' ? 'paused' : 'stopped'
    if (hold.scope === 'fleet') {
        return `Automatic rebuilds are ${verb} fleet-wide. Drift is still detected and shown. `
            + 'Resume from Automation — a source’s or provider’s own controls cannot release a fleet hold.'
    }
    if (hold.scope === 'provider') {
        return `Automatic rebuilds are ${verb} for every source under this provider. Drift is still detected and shown. `
            + 'Resume from the provider row — this source’s own controls cannot release a provider hold.'
    }
    return hold.kind === 'paused'
        ? 'An operator paused automatic rebuilds for this source. Drift is still detected and shown; '
            + 'nothing is rebuilt until the pause lapses or it is resumed from the source drawer.'
        : 'Automatic rebuilds are switched off for this source. Drift is still detected and shown, '
            + 'but nothing is rebuilt automatically — turn it back on from the source drawer.'
}

/** The one sentence added to a rebuild confirmation on a held source: a
 *  person may override, and is told the hold stays. */
export function overrideWarning(hold: RowHold): string {
    const untilAt = hold.kind === 'paused' && hold.until ? ` until ${new Date(hold.until).toLocaleString()}` : ''
    const what = hold.kind === 'paused' ? `paused${untilAt}` : 'stopped'
    const where = hold.scope === 'fleet'
        ? 'fleet-wide'
        : hold.scope === 'provider' ? 'for every source under this provider' : 'for this source'
    const stays = hold.kind === 'paused' ? 'the pause stays' : 'automation stays off'
    return `Automatic rebuilds are ${what} ${where}. Rebuilding now runs once; ${stays}.`
}
