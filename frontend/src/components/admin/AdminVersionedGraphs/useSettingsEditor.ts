/**
 * useSettingsEditor — the one save model, for a settings page and a graph's drawer alike.
 *
 *   edit      stages a value (or, on the platform, its limits); nothing is sent
 *   preview   300 ms after the last edit the server says what the staged values would do (quick);
 *             a newer edit cancels the request for the older one
 *   review    the full preview (graphs, memory, readers, the database, drafts), warnings to
 *             acknowledge, and a reason
 *   save      one PATCH with the version each value was decided on; then an Undo toast
 *   conflict  "Reload and re-apply my changes": the values are read again and the staged ones
 *             kept, at the versions now in force
 *
 * Refusals land where they belong: a 422 or 403 on the row it names, a 409 in the review with
 * the way out. The callbacks handed to rows are stable, so staging one value re-renders that row
 * (and any whose rule reads it), not all of them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
    boundsAt, EDITOR_LABEL, formatValue, limitReviewItems, reviewItems, useStagedChanges, validateStaged,
    type Limits, type PatchItem, type ResolvedValues, type ReviewItem, type Setting, type SettingValue, type StagedChanges,
} from '@/components/settings'
import {
    settingsError, useSaveSettings, useSettingsPreview, type PreviewItem, type PreviewResult, type SettingsPlace,
    type SettingsRequestError,
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
        items: ReviewItem[]
        full: PreviewResult | undefined
        fullPending: boolean
        fullError: SettingsRequestError | null
        save: (reason: string) => Promise<void>
        saving: boolean
        error: SettingsRequestError | null
        /** After a version conflict: read the values again and keep the staged ones. */
        reapply: (() => void) | undefined
        /** Changes with each save, so the next review starts with an empty reason. */
        round: number
    }
    /** "Saved 2 changes to the platform." — for an aria-live region. */
    announcement: string
    /** The last save, while it can be undone from the page itself (the toast's Undo sits outside a drawer). */
    saved: { words: string; undo: () => void } | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function useSettingsEditor({ place, values, settings, where, refetch }: {
    place: SettingsPlace
    values: ResolvedValues
    settings: Record<string, Setting>
    /** Where the changes apply, for the review and the toast: "the platform", "Sales lineage". */
    where: string
    /** Reads the values again (after a conflict). */
    refetch: () => Promise<{ data?: { values: ResolvedValues } }>
}): SettingsEditor {
    const staged = useStagedChanges(values, place.scope)
    const { notify } = useAppNotifications()
    const save = useSaveSettings(place)
    const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
    const [reviewOpen, setReviewOpen] = useState(false)
    const [saveError, setSaveError] = useState<SettingsRequestError | null>(null)
    const [round, setRound] = useState(0)
    const [announcement, setAnnouncement] = useState('')
    const [saved, setSaved] = useState<{ words: string; undo: () => void } | null>(null)
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
    const fullQuery = useSettingsPreview(place, fullItems, 'full', { enabled: reviewOpen })
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

    const doSave = async (reason: string) => {
        const sending = staged.payload()
        const valueChanges = staged.changes
        const limitChanges = staged.limitChanges
        setSaveError(null)
        try {
            const res = await save.mutateAsync({ items: sending, reason })
            // Built from the answer's versions, so the toast's Undo never sends a stale one.
            const undo: PatchItem[] = sending.map((item) => ({
                key: item.key,
                ...('value' in item ? { value: valueChanges.find((c) => c.key === item.key)?.ownBefore ?? null } : {}),
                ...('limits' in item ? { limits: limitChanges.find((l) => l.key === item.key)?.ownBefore ?? null } : {}),
                expectedVersion: res.values[item.key]?.version ?? item.expectedVersion,
            }))
            staged.markSaved()
            setServerErrors({})
            setReviewOpen(false)
            setRound((r) => r + 1)
            const words = `Saved ${plural(valueChanges.length + limitChanges.length, 'change')} to ${where}.`
            setAnnouncement(words)
            const undoIt = () => void undoNow(undo, reason)
            setSaved({ words, undo: undoIt })
            notify('success', words, { label: 'Undo', onClick: undoIt }, UNDO_MS)
        } catch (err) {
            const e = settingsError(err)
            setSaveError(e)
            const byKey: Record<string, string> = {}
            for (const p of e.errors) byKey[p.key] = p.message
            for (const d of e.denied) byKey[d.key] = d.editor ? `Only ${EDITOR_LABEL[d.editor]} can change this here. ${d.message}`.trim() : d.message
            if (Object.keys(byKey).length) setServerErrors((prev) => ({ ...prev, ...byKey }))
        }
    }

    const undoNow = async (items: PatchItem[], reason: string) => {
        try {
            await save.mutateAsync({ items, reason: `Undo: ${reason}` })
            latest.current.clearUndo()
            setSaved(null)
            setAnnouncement('Undone.')
            notify('success', 'Undone: the earlier values are back.')
        } catch (err) {
            const e = settingsError(err)
            notify('error', e.type === 'settings_conflict'
                ? 'Couldn’t undo: these settings changed again since. Set them back by hand.'
                : `Couldn’t undo: ${e.message}`)
        }
    }

    // After a conflict: read the values again, and keep the staged ones at the versions now in force.
    const reapply = saveError?.type === 'settings_conflict' ? () => {
        void refetch().then((res) => {
            if (!res.data) return
            latest.current.rebase(res.data.values)
            setSaveError(null)
        })
    } : undefined

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
            items,
            full: fullQuery.data,
            fullPending: fullQuery.isFetching,
            fullError: fullQuery.error ? settingsError(fullQuery.error) : null,
            save: doSave,
            saving: save.isPending,
            error: saveError,
            reapply,
            round,
        },
        announcement,
        saved,
    }
}
