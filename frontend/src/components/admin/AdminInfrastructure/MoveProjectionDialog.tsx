/**
 * MoveProjectionDialog — move one versioned graph's read cache to another
 * FalkorDB provider or key (``POST …/graphs/{graphId}/projection/move``).
 *
 * The move reseeds the graph from Postgres into the new key, so the dialog
 * is the confirm: it says what the move costs before anything changes, and
 * offers only active FalkorDB providers. The server picks the graph's next
 * platform key unless one is given under Advanced; a key the graph is still
 * retiring can be moved back onto in one click. Refusals arrive with a
 * ``type`` (and a ``reason``), which are turned into what to do about them.
 *
 * Built on the house dialog shell: a portal, a sibling <Backdrop>, a
 * focus-trapped panel (useModalA11y).
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft } from 'lucide-react'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/primitives'
import {
    systemStatusService,
    type GraphProvider,
    type ProjectionMoveResult,
    type VersionedGraphRow,
} from '@/services/systemStatusService'

const FIELD_CLS = 'w-full px-2 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated text-xs text-ink'

type Refusal = { type?: string; reason?: string; key?: string; providerId?: string }

interface Props {
    row: VersionedGraphRow
    providers: GraphProvider[]
    onClose: () => void
    onMoved: (result: ProjectionMoveResult) => void
}

export function MoveProjectionDialog({ row, providers, onClose, onMoved }: Props) {
    const [providerId, setProviderId] = useState('')
    const [key, setKey] = useState('')
    const [advanced, setAdvanced] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const dialogRef = useModalA11y(true, onClose)

    const targets = providers.filter(p => p.type === 'falkordb' && p.isActive)
    const nameOf = (id: string | null) => providers.find(p => p.id === id)?.name ?? id ?? 'default'
    // A move back needs its provider to be a target still; the built-in default is not one.
    const backTo = row.retiredKeys.filter(k => targets.some(p => p.id === k.provider))

    const explain = (e: Error & { detail?: unknown }): string => {
        const d: Refusal = typeof e.detail === 'object' && e.detail ? e.detail as Refusal : {}
        if (d.type === 'projection_not_adopted' && d.reason === 'customer_key') return "This is the customer's own graph. Only platform copies can be moved."
        if (d.type === 'projection_not_adopted' && d.reason === 'shared') return 'Other data sources read this key.'
        if (d.type === 'graph_key_in_use') return `${d.key} already exists on ${nameOf(d.providerId ?? null)}.`
        if (d.type === 'invalid_target_key') return `${d.key} is not a key this graph can move to. Leave the key empty to create one.`
        if (d.type === 'job_active') return 'A rollup rebuild is running; try again when it finishes.'
        if (d.type === 'provider_unreachable') return 'That provider cannot be reached right now; try again.'
        if (d.type === 'bootstrapping') return 'Version control is still being enabled for this graph; try again when it finishes.'
        if (d.type === 'lock_busy') return 'The graph is busy; try again in a few seconds.'
        return e.message
    }

    const move = async () => {
        setPending(true)
        setError(null)
        try {
            const k = key.trim()
            onMoved(await systemStatusService.moveProjection(row.graphId, k ? { providerId, key: k } : { providerId }))
        } catch (e) {
            setError(explain(e as Error))
            setPending(false)
        }
    }

    return createPortal(
        <>
            <Backdrop open onClick={pending ? undefined : onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                <div
                    ref={dialogRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="move-projection-title"
                    className="pointer-events-auto outline-none w-full max-w-lg rounded-xl border border-glass-border bg-canvas-elevated shadow-lg"
                >
                    <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                        <ArrowRightLeft className="w-4 h-4 text-indigo-500" />
                        <div className="min-w-0">
                            <h2 id="move-projection-title" className="text-sm font-semibold text-ink">Move read cache</h2>
                            <p className="text-[11px] text-ink-muted truncate">
                                {row.dataSourceLabel ?? row.dataSourceId} · now on {nameOf(row.falkorProvider)} · <span className="font-mono">{row.falkorGraphName}</span>
                            </p>
                        </div>
                    </div>

                    <div className="px-5 pb-4 space-y-3 text-xs">
                        {backTo.map(k => (
                            <Button
                                key={`${k.provider}:${k.name}`}
                                size="sm"
                                variant="subtle"
                                disabled={pending}
                                onClick={() => { setProviderId(k.provider ?? ''); setKey(k.name); setAdvanced(true) }}
                            >
                                Move back to {nameOf(k.provider)} · {k.name}
                            </Button>
                        ))}

                        <label className="block space-y-1">
                            <span className="text-ink-secondary">Target provider</span>
                            <select className={FIELD_CLS} value={providerId} disabled={pending} onChange={e => setProviderId(e.target.value)}>
                                <option value="">Choose a FalkorDB provider</option>
                                {targets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </label>

                        <button type="button" className="text-[11px] text-ink-muted hover:text-ink" onClick={() => setAdvanced(a => !a)}>
                            Advanced
                        </button>
                        {advanced && (
                            <label className="block space-y-1">
                                <span className="text-ink-secondary">Target key</span>
                                <input
                                    className={FIELD_CLS + ' font-mono'}
                                    value={key}
                                    disabled={pending}
                                    onChange={e => setKey(e.target.value)}
                                    placeholder={`leave empty to create gvp_${row.graphId}{…}`}
                                />
                            </label>
                        )}

                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            Reads come from Postgres until the new copy catches up; aggregated lineage is missing until its rollups are rebuilt.
                            The current platform key is removed about 15 minutes after the new one catches up — until then you can move back.
                        </p>
                        {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
                    </div>

                    <div className="px-5 py-3 border-t border-glass-border flex justify-end gap-2">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
                        <Button size="sm" variant="primary" disabled={!providerId} loading={pending} onClick={move}>Move</Button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
