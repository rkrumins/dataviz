/**
 * DraftRetentionCard — "Draft retention": how long a merged or abandoned draft keeps its changes
 * before the versioning worker removes them, changed live, with no redeploy.
 *
 * It shows the window in force and its default, and saves a new one: 0 keeps changes for good, and
 * Reset goes back to the default. A window that removes more than the one in force asks first, and
 * says what it does. Within the hour, every draft closed longer ago loses its changes, and they
 * don't come back. Each draft keeps its record (name, owner, commits and review), and a published
 * draft's changes stay in the published graph.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Hourglass, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { systemStatusService } from '@/services/systemStatusService'
import { ConfirmDialog } from './ConfirmDialog'

const FIELD_CLS = 'w-24 px-2 py-1 rounded-lg border border-glass-border bg-canvas text-xs text-ink tabular-nums'
const RESET = '\u0000reset'
const LABEL = "Keep a closed draft's changes for"

/** "30 days", "1 day", "for good". */
function span(days: number): string {
    if (days === 0) return 'for good'
    return `${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}`
}

/** Whether ``next`` removes changes ``current`` keeps: shorter, or a window where there was none. */
function removesMore(current: number, next: number): boolean {
    return next !== 0 && (current === 0 || next < current)
}

export function DraftRetentionCard() {
    const qc = useQueryClient()
    const retentionQ = useQuery({
        queryKey: ['admin', 'draft-retention'],
        queryFn: systemStatusService.draftRetention,
        refetchOnWindowFocus: false,
    })
    const [edit, setEdit] = useState<string | undefined>(undefined)
    const [error, setError] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<{ days: number | null; effective: number } | null>(null)
    const [pending, setPending] = useState(false)
    const [failure, setFailure] = useState<string | null>(null)
    const r = retentionQ.data

    if (retentionQ.isLoading) {
        return <p className="px-5 py-3 text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading draft retention…</p>
    }
    if (!r) {
        return <p className="px-5 py-3 text-xs text-red-600 dark:text-red-400">{(retentionQ.error as Error | null)?.message ?? 'Draft retention could not be read.'}</p>
    }

    const current = edit === RESET ? String(r.default) : edit ?? String(r.days)
    const changed = edit !== undefined ? edit !== RESET : r.saved !== null

    const commit = async (days: number | null) => {
        setPending(true)
        setFailure(null)
        try {
            await systemStatusService.saveDraftRetention(days)
            setConfirm(null)
            setEdit(undefined)
            void qc.invalidateQueries({ queryKey: ['admin', 'draft-retention'] })
        } catch (e) {
            setFailure((e as Error).message)
        } finally {
            setPending(false)
        }
    }

    const save = () => {
        if (edit === undefined) return
        let days: number | null = null
        if (edit !== RESET) {
            const n = Number(edit)
            if (edit.trim() === '' || !Number.isInteger(n) || n < r.min || n > r.max) {
                setError(`Enter a whole number of days from ${r.min} to ${r.max.toLocaleString()}.`)
                return
            }
            days = n
        }
        setError(null)
        const effective = days ?? r.default
        if (removesMore(r.days, effective)) setConfirm({ days, effective })
        else void commit(days)
    }

    return (
        <section aria-label="Draft retention" className="mx-5 mb-4 rounded-xl border border-glass-border bg-canvas-elevated/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Hourglass className="w-4 h-4 text-indigo-500" />
                <div>
                    <h3 className="text-sm font-semibold text-ink">Draft retention</h3>
                    <p className="text-[11px] text-ink-muted">
                        {r.days === 0
                            ? 'Merged and abandoned drafts keep their changes for good.'
                            : `A merged or abandoned draft keeps its changes ${span(r.days)}, then they are removed.`}
                        {' '}Its name, owner, commits and review stay, and a published draft's changes are in the published graph.
                    </p>
                </div>
            </div>
            <div role="group" aria-label={LABEL} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
                <div className="min-w-0">
                    <span className="text-xs font-medium text-ink">{LABEL}</span>
                    <span className="block text-[10.5px] text-ink-muted">
                        {r.min} to {r.max.toLocaleString()} days; 0 keeps them for good. Default: {span(r.default)}
                    </span>
                    {error && <span className="block text-[11px] text-red-600 dark:text-red-400">{error}</span>}
                </div>
                <div className="flex items-center gap-1.5 justify-end">
                    <input
                        type="number"
                        aria-label={LABEL}
                        className={FIELD_CLS}
                        min={r.min}
                        max={r.max}
                        step={1}
                        value={current}
                        onChange={e => setEdit(e.target.value)}
                    />
                    <span className="text-xs text-ink-muted">days</span>
                    <button
                        type="button"
                        aria-label="Reset to default"
                        disabled={!changed}
                        onClick={() => setEdit(RESET)}
                        className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                    >
                        Reset
                    </button>
                </div>
            </div>
            <div className="flex items-center justify-end gap-2">
                {failure && !confirm && <p className="text-[11px] text-red-600 dark:text-red-400 mr-auto">{failure}</p>}
                <Button size="sm" variant="ghost" disabled={pending || edit === undefined} onClick={() => { setEdit(undefined); setError(null) }}>
                    Discard
                </Button>
                <Button size="sm" variant="primary" loading={pending && !confirm} disabled={edit === undefined} onClick={save}>
                    Save
                </Button>
            </div>
            {confirm && (
                <ConfirmDialog
                    title="Remove closed drafts' changes sooner?"
                    confirmLabel="Save and remove"
                    onConfirm={() => void commit(confirm.days)}
                    onClose={() => { setConfirm(null); setFailure(null) }}
                    pending={pending}
                    error={failure}
                >
                    <p>
                        Within the hour, every draft merged or abandoned more than {span(confirm.effective)} ago loses its
                        changes. They can't be brought back, even if you lengthen the window again.
                    </p>
                    <p>
                        Each draft keeps its name, owner, commits and review, and a published draft's changes stay in the
                        published graph.
                    </p>
                </ConfirmDialog>
            )}
        </section>
    )
}
