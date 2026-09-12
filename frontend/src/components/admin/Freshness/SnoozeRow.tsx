/**
 * SnoozeRow — the operator hold on automatic rebuilds, at any scope.
 *
 * One control, three homes: the source drawer (③ Act), the provider dialog,
 * and the Automation modal's ③ Act. It is the same row in all three so a
 * pause never looks like a different feature depending on where it is set.
 *
 * Two kinds, visibly distinct: a PAUSE is timed and lapses on its own; a STOP
 * (provider and fleet only — a source's stop is its "rebuild automatically"
 * toggle) holds until someone resumes it. Most restrictive wins across
 * fleet → provider → source, so when a WIDER hold is in force this row turns
 * into a read-out that names the control that will actually release it: a
 * source-level Resume cannot lift a provider hold, and offering one would be
 * a button that does nothing.
 *
 * A hold gates the rebuild only — the source is still probed, still checked,
 * and still records its finding — so the words are "pause rebuilds", never
 * "pause automation", which would claim the two stages above it stop too.
 */
import { PauseCircle, RotateCcw, StopCircle } from 'lucide-react'
import type { HoldKind, HoldScope } from '@/services/freshnessService'
import { SNOOZE_CHOICES, hintIdFor } from './automationCopy'
import { SettingRow } from './StageRow'
import { timeUntil } from './holds'

/** What a choice on this row writes. ``stopped`` is only ever set for the
 *  scopes that have a stop of their own (provider, fleet). */
export interface SnoozePatch {
    pausedUntil: string | null
    stopped?: boolean
}

/** A hold at a WIDER scope than the row's own — rendered as a read-out. */
export interface InheritedHold {
    scope: HoldScope
    kind: HoldKind
    until: string | null
}

// The same two class strings the drawer's ledger uses. Duplicated rather
// than imported: the drawer imports this file, and a style constant is not
// worth a module cycle.
const QUIET_BTN = 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold '
    + 'text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 '
    + 'transition-colors motion-reduce:transition-none disabled:opacity-50 outline-none '
    + 'focus-visible:ring-2 focus-visible:ring-indigo-500/50'

const SELECT_BOX = 'h-7 px-2 rounded-lg border border-glass-border bg-canvas text-[12px] text-ink '
    + 'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-50'

const STOP_VALUE = 'stop'

const WORDS: Record<HoldScope, { pauseFor: string; paused: string; stopped: string; hint: string }> = {
    source: {
        pauseFor: 'Pause rebuilds for',
        paused: 'Rebuilds are paused',
        stopped: 'Rebuilds are stopped',
        hint: 'Problems are still detected, checked and shown here — only the rebuild is held, so a source can be left alone without losing sight of it.',
    },
    provider: {
        pauseFor: "Pause this provider's rebuilds for",
        paused: "This provider's rebuilds are paused",
        stopped: "This provider's rebuilds are stopped",
        hint: 'Every source under this provider. Problems are still detected and shown — only rebuilds are held, and no source’s own controls can release a provider hold.',
    },
    fleet: {
        pauseFor: 'Pause every rebuild for',
        paused: 'Every rebuild is paused fleet-wide',
        stopped: 'Every rebuild is stopped fleet-wide',
        hint: 'Every source, every provider. Problems are still detected and shown — only rebuilds are held, and no source or provider control can release a fleet hold.',
    },
}

function whereToResume(scope: HoldScope): string {
    return scope === 'fleet' ? 'Automation' : 'the provider row'
}

function byPhrase(scope: HoldScope): string {
    return scope === 'fleet' ? 'fleet-wide' : 'by the provider'
}

function fmt(iso: string | null | undefined): string | null {
    if (!iso) return null
    const t = Date.parse(iso)
    return Number.isNaN(t) ? null : new Date(t).toLocaleString()
}

export function SnoozeRow({
    scope, pausedUntil, stoppedAt, inherited, pending, disabled = false, allowStop = false,
    idPrefix, onPatch,
}: {
    /** The scope THIS row controls. */
    scope: HoldScope
    /** This scope's own timed pause, if any. */
    pausedUntil?: string | null
    /** This scope's own indefinite stop, if any (an ISO stamp, or any truthy
     *  marker when the stamp is not known). Never set for a source. */
    stoppedAt?: string | null
    /** A hold at a wider scope, which outranks anything set here. */
    inherited?: InheritedHold | null
    pending: boolean
    disabled?: boolean
    /** Offer "until resumed" — the indefinite stop. Provider and fleet only. */
    allowStop?: boolean
    /** Unique per host, so the label points at this row's control. */
    idPrefix: string
    onPatch: (patch: SnoozePatch, ok: string) => void
}) {
    const words = WORDS[scope]

    if (inherited) {
        const until = inherited.kind === 'paused' ? fmt(inherited.until) : null
        return (
            <SettingRow
                label={`Rebuilds are held ${byPhrase(inherited.scope)}`}
                hint={`${until ? `Until ${until}` : 'Stopped until someone resumes it'} — resume it from ${whereToResume(inherited.scope)}.`}
            >
                {inherited.kind === 'paused'
                    ? <PauseCircle className="w-4 h-4 text-slate-400 shrink-0" aria-hidden />
                    : <StopCircle className="w-4 h-4 text-slate-400 shrink-0" aria-hidden />}
            </SettingRow>
        )
    }

    const pausedFor = timeUntil(pausedUntil)
    if (stoppedAt || pausedFor) {
        const since = stoppedAt ? fmt(stoppedAt) : null
        return (
            <SettingRow
                label={stoppedAt ? words.stopped : words.paused}
                hint={stoppedAt
                    ? (since ? `Since ${since} — until someone resumes it.` : 'Until someone resumes it.')
                    : `Until ${fmt(pausedUntil) ?? pausedUntil}`}
            >
                <button
                    type="button"
                    onClick={() => onPatch(
                        { pausedUntil: null, ...(allowStop ? { stopped: false } : {}) },
                        'Rebuilds resumed.',
                    )}
                    disabled={pending || disabled}
                    className={QUIET_BTN}
                >
                    <RotateCcw className="w-3.5 h-3.5" /> Resume now
                </button>
            </SettingRow>
        )
    }

    const id = `${idPrefix}-select`
    return (
        <SettingRow label={words.pauseFor} htmlFor={id} hint={words.hint} disabled={disabled}>
            <select
                id={id}
                aria-describedby={hintIdFor(id)}
                disabled={pending || disabled}
                // Always empty: this picks an action, not a stored value. What
                // was chosen reads back as the expiry, which replaces this row.
                value=""
                onChange={(e) => {
                    if (e.target.value === STOP_VALUE) {
                        onPatch({ pausedUntil: null, stopped: true }, 'Rebuilds stopped until resumed.')
                        return
                    }
                    const choice = SNOOZE_CHOICES.find(c => String(c.secs) === e.target.value)
                    if (!choice) return
                    onPatch(
                        { pausedUntil: new Date(Date.now() + choice.secs * 1000).toISOString() },
                        `Rebuilds paused for ${choice.label}.`,
                    )
                }}
                className={SELECT_BOX}
            >
                <option value="">Choose…</option>
                {SNOOZE_CHOICES.map(c => (
                    <option key={c.secs} value={c.secs}>{c.label}</option>
                ))}
                {allowStop && <option value={STOP_VALUE}>Until resumed (stop)</option>}
            </select>
        </SettingRow>
    )
}
