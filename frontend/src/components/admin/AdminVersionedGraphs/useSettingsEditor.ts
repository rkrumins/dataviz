/**
 * useSettingsEditor — the one save model, for a settings page and a graph's drawer alike.
 *
 *   edit      stages a value (or, on the platform, its limits); nothing is sent
 *   preview   300 ms after the last edit the server says what the staged values would do (quick);
 *             a newer edit cancels the request for the older one
 *   review    the full preview (graphs, memory, readers, the database, drafts), warnings to
 *             acknowledge, and a reason; in the review dialog, or drawn inline (`setInline`, the
 *             guided setup's last step), where the full preview runs without the dialog
 *   save      one PATCH with the version each value was decided on and the warnings acknowledged;
 *             then one confirmation with Undo: the app's toast on a page, a bar in place in a
 *             drawer (`confirm`), never both; or none, for a caller that confirms it its own way
 *             (`save(reason, { confirm: false })`, with the Undo in `saved`)
 *   conflict  someone saved one of these values since it was read: the values are read again
 *             with who changed what and when (the history), the staged ones are kept at the
 *             versions now in force, and the review lists each value from theirs to yours, with
 *             a warning naming their change that must be acknowledged before Save. If reading
 *             again fails, "Reload and re-apply my changes" tries again.
 *
 * Refusals land where they belong: a 422 or 403 on the row it names, a 409 in the review with
 * the way out. A save refused for a warning it didn't acknowledge puts that warning in the review
 * to acknowledge. The callbacks handed to rows are stable, so staging one value re-renders that
 * row (and any whose rule reads it), not all of them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { smartTime } from '@/lib/smartTime'
import {
    boundsAt, EDITOR_LABEL, formatValue, limitReviewItems, ownValue, reviewItems, sameValue, useStagedChanges, validateStaged,
    type Limits, type PatchItem, type ResolvedValues, type ReviewItem, type Setting, type SettingValue, type StagedChanges,
} from '@/components/settings'
import {
    settingsError, settingsService, useSaveSettings, useSettingsPreview, type HistoryEntry, type Impact, type PreviewItem,
    type PreviewResult, type SettingConflict, type SettingsPlace, type SettingsRequestError, type SettingsWarning,
} from '@/services/settingsService'
import { validateLimits } from './limits'

const QUICK_PREVIEW_MS = 300
const UNDO_MS = 10_000

export interface SettingsEditor {
    staged: StagedChanges
    /** Stable: safe to hand to memoised rows. */
    stage: (key: string, value: SettingValue | null) => void
    unstage: (key: string) => void
    stageLimits: (key: string, limits: Limits | null) => void
    unstageLimits: (key: string) => void
    /** What is wrong with a staged value: the page's own checks, then the server's refusals. */
    errors: Record<string, string>
    /** What is wrong with staged limits, by key. */
    limitErrors: Record<string, string>
    problems: number
    /** The server's answer for the staged values (quick preview), by key. */
    quick: Record<string, PreviewItem>
    quickPending: boolean
    review: {
        open: boolean
        setOpen: (open: boolean) => void
        /** The review is drawn in place of the dialog: the full preview runs while it is. */
        setInline: (inline: boolean) => void
        items: ReviewItem[]
        /** The full preview, with what the review must also have acknowledged: a warning the server refused a save for, someone else's change since. */
        full: PreviewResult | undefined
        fullPending: boolean
        fullError: SettingsRequestError | null
        /** Asks for the full preview again. */
        retryFull: () => void
        /**
         * Saves what is staged, with `reason`: true once it is saved. `confirm: false` leaves the
         * confirmation to the caller: no toast and no bar, the Undo held in `saved` all the same.
         */
        save: (reason: string, options?: { confirm?: boolean }) => Promise<boolean>
        saving: boolean
        error: SettingsRequestError | null
        /** After a version conflict the values couldn't be read again for: try again. */
        reapply: (() => void) | undefined
        /** Changes with each save, so the next review starts with an empty reason. */
        round: number
    }
    /** "Saved 2 changes to the platform." — for an aria-live region. */
    announcement: string
    /**
     * With `confirm: 'bar'`, or a save made with `confirm: false`: the last save, while it can be
     * undone from where it was made. `undo` is true once the earlier values are back; when it
     * isn't, `announcement` says why.
     */
    saved: { words: string; undo: () => Promise<boolean> } | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const warningId = (w: SettingsWarning) => `${w.code}:${w.key ?? ''}`
const NO_WARNINGS: SettingsWarning[] = []

/** Someone else's change to a value staged here: what it was, and the value staged over it. */
interface Overwrite {
    key: string
    /** Their change, from the history; null when it couldn't be read. */
    change: HistoryEntry | null
    /** The value chosen here now: theirs. */
    theirs: SettingValue | null
}

/**
 * Their change in words, to acknowledge before saving over it: "Grace Hopper changed Read mode to
 * Keep serving, update in place (5 min ago), after you opened it. Saving puts yours in its place:
 * Keep serving, switch when ready."
 */
function overwriteText(o: Overwrite, setting: Setting | undefined, yours: SettingValue | null | undefined, limits: boolean): string {
    const label = setting?.label ?? o.key
    const say = (v: SettingValue | null) => (v === null ? 'nothing of its own, so it inherits' : setting ? formatValue(setting, v) : String(v))
    const c = o.change
    const who = c ? (c.actor ? c.actor.name ?? 'Someone' : 'The system') : 'Someone'
    const when = c ? ` (${smartTime(new Date(c.at), Date.now())})` : ''
    // Theirs changed the limits alone, or the value; yours stages the value, the limits, or both.
    const theirLimits = Boolean(c && sameValue(c.from.value, c.to.value))
    const what = theirLimits ? `changed what workspaces and graphs may choose for ${label}` : `changed ${label} to ${say(c ? c.to.value : o.theirs)}`
    const mine = yours === undefined ? ''
        : theirLimits ? `${limits ? 'Saving puts your limits in place of theirs and sets' : 'Saving keeps their limits and sets'} yours: ${say(yours)}.`
            : `Saving puts yours in its place: ${say(yours)}${limits ? ', with your limits' : ''}.`
    const onlyLimits = yours !== undefined || !limits ? ''
        : theirLimits ? 'Saving puts your limits in place of theirs.' : 'Saving keeps their value and puts your limits in place.'
    return `${who} ${what}${when}, after you opened it. ${mine}${onlyLimits}`.trim()
}

/** Who changed each conflicting value, from the place's history: the newest change past the version decided on. */
async function theirChanges(place: SettingsPlace, conflicts: SettingConflict[]): Promise<Record<string, HistoryEntry | null>> {
    const found = await Promise.all(conflicts.map(async (c) => {
        try {
            const page = await settingsService.history(place, place.scope === 'platform' ? { key: c.key, scope: c.scope } : { key: c.key })
            return [c.key, page.entries.find((e) => e.key === c.key && e.scope === c.scope && e.scopeId === c.scopeId && e.version > c.expected) ?? null] as const
        } catch {
            return [c.key, null] as const
        }
    }))
    return Object.fromEntries(found)
}

export function useSettingsEditor({ place, values, settings, where, refetch, confirm = 'toast' }: {
    place: SettingsPlace
    values: ResolvedValues
    settings: Record<string, Setting>
    /** Where the changes apply, for the review and the toast: "the platform", "Sales lineage". */
    where: string
    /** Reads the values again (after a conflict). */
    refetch: () => Promise<{ data?: { values: ResolvedValues }; error?: unknown }>
    /**
     * How a save is confirmed, with its Undo: the app's toast (a page), or `saved`, for a bar where
     * the save was made (a drawer, which holds the keyboard's focus away from the toast).
     */
    confirm?: 'toast' | 'bar'
}): SettingsEditor {
    const staged = useStagedChanges(values, place.scope)
    const { notify } = useAppNotifications()
    const save = useSaveSettings(place)
    const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
    const [reviewOpen, setReviewOpen] = useState(false)
    const [reviewInline, setReviewInline] = useState(false)
    const [saveError, setSaveError] = useState<SettingsRequestError | null>(null)
    const [round, setRound] = useState(0)
    const [announcement, setAnnouncement] = useState('')
    const [saved, setSaved] = useState<{ words: string; undo: () => Promise<boolean> } | null>(null)
    // Warnings a save was refused for, with the body it was refused for: they stand while it does.
    const [owed, setOwed] = useState<{ body: string; warnings: SettingsWarning[] } | null>(null)
    // Values someone else saved since they were read, the staged ones now over theirs.
    const [overwrites, setOverwrites] = useState<Overwrite[]>([])
    const [reconciling, setReconciling] = useState(false)
    useEffect(() => {
        if (!saved) return
        const t = setTimeout(() => setSaved(null), UNDO_MS)
        return () => clearTimeout(t)
    }, [saved])

    // The latest staging, for callbacks that must stay the same function across renders.
    const latest = useRef(staged)
    useLayoutEffect(() => { latest.current = staged })

    const forget = useCallback((key: string) => setServerErrors((prev) => {
        if (!(key in prev)) return prev
        const rest = { ...prev }
        delete rest[key]
        return rest
    }), [])
    // Stable: a review drawn inline turns it on and off from an effect.
    const setInline = useCallback((inline: boolean) => {
        setReviewInline(inline)
        if (!inline) setSaveError(null)
    }, [])

    const stage = useCallback((key: string, value: SettingValue | null) => { latest.current.stage(key, value); forget(key) }, [forget])
    const unstage = useCallback((key: string) => { latest.current.unstage(key); forget(key) }, [forget])
    const stageLimits = useCallback((key: string, limits: Limits | null) => { latest.current.stageLimits(key, limits); forget(key) }, [forget])
    const unstageLimits = useCallback((key: string) => { latest.current.unstageLimits(key); forget(key) }, [forget])

    // ── Checks ──────────────────────────────────────────────────────────────
    const stagedValues = useMemo(() => Object.fromEntries(staged.changes.map((c) => [c.key, c.ownAfter])), [staged.changes])
    const clientErrors = useMemo(() => validateStaged(settings, stagedValues, (key) => ({
        values: staged.next,
        bounds: boundsAt(settings[key], values[key], place.scope),
        allowed: values[key]?.allowed,
    })), [settings, stagedValues, staged.next, values, place.scope])
    const limitErrors = useMemo(() => Object.fromEntries(staged.limitChanges.flatMap((l) => {
        const s = settings[l.key]
        const err = s && l.ownAfter ? validateLimits(s, l.ownAfter) : null
        return err ? [[l.key, err]] : []
    })), [settings, staged.limitChanges])
    const errors = useMemo(() => ({ ...clientErrors, ...serverErrors }), [clientErrors, serverErrors])
    const problems = Object.keys(errors).length + Object.keys(limitErrors).length

    // ── Previews ────────────────────────────────────────────────────────────
    const payload = staged.payload()
    const body = JSON.stringify(payload)
    const settled = useDebouncedValue(body, QUICK_PREVIEW_MS)
    const quickItems = useMemo(() => JSON.parse(settled) as PatchItem[], [settled])
    const quickQuery = useSettingsPreview(place, problems ? [] : quickItems, 'quick')
    const fullItems = useMemo(() => JSON.parse(body) as PatchItem[], [body])
    const fullQuery = useSettingsPreview(place, fullItems, 'full', { enabled: reviewOpen || reviewInline })
    const quick = useMemo(() => (payload.length ? quickQuery.data?.values ?? {} : {}), [payload.length, quickQuery.data])

    // ── Review ──────────────────────────────────────────────────────────────
    const items = useMemo(() => {
        const answered = fullQuery.data?.values ?? {}
        // The server's answer has the last word on what is in force once saved.
        const valueItems = reviewItems(staged.changes, settings, values, place.scope).map((item) => {
            const s = settings[item.key]
            const after = answered[item.key]
            return s && after ? { ...item, to: formatValue(s, after.effective) } : item
        })
        return [...valueItems, ...limitReviewItems(staged.limitChanges, settings)]
    }, [fullQuery.data, staged.changes, staged.limitChanges, settings, values, place.scope])

    // What the review must also have acknowledged: the warnings a save of these very changes was
    // refused for, and each value of someone else's the staged one now replaces.
    const refused = owed?.body === body ? owed.warnings : NO_WARNINGS
    const { changes: valueChanges, limitChanges } = staged
    const replacing = useMemo(() => overwrites.flatMap((o): SettingsWarning[] => {
        const value = valueChanges.find((c) => c.key === o.key)
        const limits = limitChanges.some((l) => l.key === o.key)
        if (!value && !limits) return []
        return [{ code: 'overwrites', key: o.key, text: overwriteText(o, settings[o.key], value?.ownAfter, limits) }]
    }), [overwrites, valueChanges, limitChanges, settings])
    const full = useMemo((): PreviewResult | undefined => {
        const extra = [...refused, ...replacing]
        const data = fullQuery.data
        if (!extra.length) return data
        // Without the impact, the warnings still need acknowledging: they stand alone, every part of
        // the impact named as not worked out.
        const base: Impact | null = data?.impact ?? (fullQuery.error ? {
            graphs: null, alwaysLatest: null, memory: null, residency: null, database: null, drafts: null, outsideLimits: null,
            warnings: [], unavailable: ['graphs', 'alwaysLatest', 'memory', 'residency', 'database', 'drafts', 'outsideLimits'],
        } : null)
        if (!base) return data
        const seen = new Set(base.warnings.map(warningId))
        return { mode: 'full', values: data?.values ?? {}, impact: { ...base, warnings: [...base.warnings, ...extra.filter((w) => !seen.has(warningId(w)))] } }
    }, [refused, replacing, fullQuery.data, fullQuery.error])

    // Someone saved some of these values since they were read: read them again with who changed
    // what, and keep the staged ones over theirs, at the versions now in force, to review.
    const reconcile = async (e: SettingsRequestError) => {
        setReconciling(true)
        try {
            const [res, changes] = await Promise.all([refetch(), theirChanges(place, e.conflicts)])
            if (res.error || !res.data) throw res.error ?? new Error('no values')
            const fresh = res.data.values
            // They may have chosen what was staged: then nothing of it is left to save.
            const left = latest.current.changes.some((c) => fresh[c.key] && !sameValue(c.ownAfter, ownValue(fresh[c.key], place.scope)))
                || latest.current.limitChanges.length > 0
            latest.current.rebase(fresh)
            if (!left) {
                setSaveError(null)
                setReviewOpen(false)
                setAnnouncement('Nothing was saved: someone saved the same values since you opened them.')
                notify('info', 'Nothing to save: someone saved the same values since you opened them.')
                return
            }
            setOverwrites(e.conflicts.filter((c) => fresh[c.key]).map((c) => ({
                key: c.key, change: changes[c.key] ?? null, theirs: ownValue(fresh[c.key], place.scope),
            })))
            setSaveError(null)
            setAnnouncement(`Nothing was saved: ${plural(e.conflicts.length, 'value')} changed since you opened ${e.conflicts.length === 1 ? 'it' : 'them'}. Review their change before saving yours over it.`)
        } catch {
            setSaveError(e)
        } finally {
            setReconciling(false)
        }
    }

    const doSave = async (reason: string, options?: { confirm?: boolean }): Promise<boolean> => {
        if (reconciling) return false
        // Confirmed here (the toast, or a bar), or by the caller in its own way.
        const confirmHere = options?.confirm !== false
        const sending = staged.payload()
        // Save stays off until every warning shown is acknowledged: the server's are sent back.
        const acknowledge = [...new Set([...(fullQuery.data?.impact?.warnings ?? []), ...refused].map((w) => w.code))]
        setSaveError(null)
        try {
            const res = await save.mutateAsync({ items: sending, reason, acknowledge })
            // Built from the answer's versions, so the Undo never sends a stale one.
            const undo: PatchItem[] = sending.map((item) => ({
                key: item.key,
                ...('value' in item ? { value: valueChanges.find((c) => c.key === item.key)?.ownBefore ?? null } : {}),
                ...('limits' in item ? { limits: limitChanges.find((l) => l.key === item.key)?.ownBefore ?? null } : {}),
                expectedVersion: res.values[item.key]?.version ?? item.expectedVersion,
            }))
            staged.markSaved()
            setServerErrors({})
            setOwed(null)
            setOverwrites([])
            setReviewOpen(false)
            setRound((r) => r + 1)
            const words = `Saved ${plural(valueChanges.length + limitChanges.length, 'change')} to ${where}.`
            setAnnouncement(words)
            const undoIt = () => undoNow(undo, reason, confirmHere)
            if (!confirmHere || confirm === 'bar') setSaved({ words, undo: undoIt })
            else notify('success', words, { label: 'Undo', onClick: () => void undoIt() }, UNDO_MS)
            return true
        } catch (err) {
            const e = settingsError(err)
            if (e.type === 'settings_conflict') {
                void reconcile(e)
                return false
            }
            if (e.type === 'acknowledgement_required') setOwed({ body: JSON.stringify(sending), warnings: e.warnings })
            setSaveError(e)
            const byKey: Record<string, string> = {}
            for (const p of e.errors) byKey[p.key] = p.message
            for (const d of e.denied) byKey[d.key] = d.editor ? `Only ${EDITOR_LABEL[d.editor]} can change this here. ${d.message}`.trim() : d.message
            if (Object.keys(byKey).length) setServerErrors((prev) => ({ ...prev, ...byKey }))
            return false
        }
    }

    /** Puts back what a save changed. `confirmHere`: say so with a toast; else its caller does. */
    const undoNow = async (items: PatchItem[], reason: string, confirmHere: boolean): Promise<boolean> => {
        const send = (acknowledge?: string[]) => save.mutateAsync({ items, reason: `Undo: ${reason}`, acknowledge })
        try {
            // Undo puts back the values in force a moment ago: what that warns about was so before
            // this save, and the person asked for it back.
            await send().catch((err: unknown) => {
                const e = settingsError(err)
                if (e.type !== 'acknowledgement_required') throw err
                return send(e.warnings.map((w) => w.code))
            })
            latest.current.clearUndo()
            setSaved(null)
            setAnnouncement('Undone.')
            if (confirmHere) notify('success', 'Undone: the earlier values are back.')
            return true
        } catch (err) {
            const e = settingsError(err)
            const words = e.type === 'settings_conflict'
                ? 'Couldn’t undo: these settings changed again since. Set them back by hand.'
                : `Couldn’t undo: ${e.message}`
            setAnnouncement(words)
            if (confirmHere) notify('error', words)
            return false
        }
    }

    // The values couldn't be read again after a conflict: try again.
    const conflict = saveError?.type === 'settings_conflict' ? saveError : null
    const reapply = conflict ? () => { void reconcile(conflict) } : undefined

    return {
        staged, stage, unstage, stageLimits, unstageLimits, errors, limitErrors, problems,
        quick,
        quickPending: quickQuery.isFetching && payload.length > 0,
        review: {
            open: reviewOpen,
            setOpen: (open) => {
                setReviewOpen(open)
                if (!open) setSaveError(null)
            },
            setInline,
            items,
            full,
            fullPending: fullQuery.isFetching,
            fullError: fullQuery.error ? settingsError(fullQuery.error) : null,
            retryFull: () => { void fullQuery.refetch() },
            save: doSave,
            saving: save.isPending || reconciling,
            error: saveError,
            reapply,
            round,
        },
        announcement,
        saved,
    }
}
