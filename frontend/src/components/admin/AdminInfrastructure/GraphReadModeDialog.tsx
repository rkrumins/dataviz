/**
 * GraphReadModeDialog — what one graph's readers get while a newer version of it lands: the
 * platform's default (named), or a mode of its own. Each choice explains itself (ReadModePicker).
 * Switch when ready needs a key the platform owns, and New-version builds on (Admin → Features):
 * a customer's own key can't take it, and without the switch it is saved but the graph updates in
 * place until it is on. Saving applies to the next read.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/primitives'
import { systemStatusService, type ReadMode, type VersionedGraphRow } from '@/services/systemStatusService'
import { ReadModePicker } from './ReadModePicker'
import { READ_MODE } from './readModes'

interface Props {
    row: VersionedGraphRow
    onClose: () => void
    onSaved: (result: { graphId: string; readMode: ReadMode | null; readModeEffective: ReadMode }) => void
}

export function GraphReadModeDialog({ row, onClose, onSaved }: Props) {
    const dialogRef = useModalA11y(true, onClose)
    const policyQ = useQuery({
        queryKey: ['admin', 'build-policy'],
        queryFn: systemStatusService.buildPolicy,
        refetchOnWindowFocus: false,
    })
    const [choice, setChoice] = useState<ReadMode | null>(row.readMode)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const platform = (policyQ.data?.values.readMode?.effective as ReadMode | undefined) ?? 'latest'
    const switchOn = policyQ.data?.enabled ?? false
    const name = row.dataSourceLabel ?? row.dataSourceId
    const now = row.readModeEffective ? READ_MODE[row.readModeEffective].title : null

    const save = async () => {
        setPending(true)
        setError(null)
        try {
            onSaved(await systemStatusService.setGraphReadMode(row.graphId, choice))
        } catch (e) {
            const detail = (e as { detail?: { message?: string } }).detail
            setError(detail?.message ?? (e as Error).message)
        } finally {
            setPending(false)
        }
    }

    return createPortal(
        <>
            <Backdrop open onClick={pending ? undefined : onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none overflow-y-auto">
                <div
                    ref={dialogRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="read-mode-dialog-title"
                    className="pointer-events-auto outline-none w-full max-w-5xl rounded-xl border border-glass-border bg-canvas-elevated shadow-lg"
                >
                    <div className="px-5 pt-4 pb-3">
                        <h2 id="read-mode-dialog-title" className="text-sm font-semibold text-ink">
                            What readers of {name} get while a new version lands
                        </h2>
                        <p className="mt-0.5 text-[11.5px] text-ink-muted">
                            Large imports and rebuilds take time to reach the graph store. Choose what people see on canvases,
                            searches and lineage meanwhile.
                            {now && <> Now: <span className="font-medium text-ink-secondary">{now}</span>{row.readMode ? ', set for this graph.' : ', the platform default.'}</>}
                        </p>
                    </div>
                    <div className="px-5 pb-4">
                        <ReadModePicker
                            value={choice}
                            onChange={setChoice}
                            inheritFrom={platform}
                            defaultMode={platform}
                            disabled={pending}
                            unavailable={row.owned ? {} : {
                                beside: "This graph is read from your own FalkorDB key, which is never copied or built beside.",
                            }}
                            notes={switchOn ? {} : {
                                beside: (
                                    <span className="text-amber-700 dark:text-amber-400">
                                        A preview: turn on New-version builds under{' '}
                                        <Link to="/admin/features" className="font-semibold underline">Admin → Features</Link>.
                                        Until then this graph updates in place.
                                    </span>
                                ),
                            }}
                        />
                        {error && <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
                    </div>
                    <div className="px-5 py-3 border-t border-glass-border flex items-center justify-between gap-3">
                        <p className="text-[10.5px] text-ink-muted">Applies to the next read. Recorded in the activity log.</p>
                        <div className="flex gap-2">
                            <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
                            <Button size="sm" variant="primary" loading={pending} disabled={choice === row.readMode} onClick={save}>
                                Save
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
