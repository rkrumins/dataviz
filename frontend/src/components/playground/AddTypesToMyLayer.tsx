/**
 * AddTypesToMyLayer — the types a file uses that the reader's own data model lacks, added to it in
 * one go (`POST /playground/layers/{id}/types`). A draft takes them in place; a published one gets
 * a new version, published, and the reader's graphs on the old one move to it — which is said.
 */
import { useState } from 'react'
import { CheckCircle2, CircleAlert, Plus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { playgroundService, type LayerTypesAdded, type LayerTypesToAdd } from '@/services/playgroundService'
import { layerRefusal } from './layerRefusal'

/** Names listed before the rest are counted. */
const NAMED = 6

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function AddTypesToMyLayer({ ontologyId, missing, onAdded }: {
    ontologyId: string
    missing: LayerTypesToAdd
    onAdded: (result: LayerTypesAdded) => void
}) {
    const { invalidateAll } = useOntologyMutations()
    const queryClient = useQueryClient()
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const names = [...missing.entityTypes, ...missing.relationshipTypes].map(t => t.name)
    if (!names.length) return null
    const listed = names.slice(0, NAMED).join(', ') + (names.length > NAMED ? `, and ${names.length - NAMED} more` : '')

    async function add() {
        setBusy(true)
        setError(null)
        try {
            const result = await playgroundService.addLayerTypes(ontologyId, missing)
            invalidateAll()
            void queryClient.invalidateQueries({ queryKey: ['playground'] })
            const moved = result.movedGraphs ? ` ${plural(result.movedGraphs, 'graph')} of yours moved to it.` : ''
            setDone(result.ontologyId === ontologyId
                ? `Added to your data model.${moved}`
                : `Added. Your data model is now v${result.version}, a new version, published.${moved}`)
            onAdded(result)
        } catch (e) {
            setError(layerRefusal(e))
        } finally {
            setBusy(false)
        }
    }

    if (done) {
        return (
            <p role="status" className="flex items-start gap-1.5 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {done}
            </p>
        )
    }
    return (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.05] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="min-w-0 flex-1 text-xs text-ink-secondary">
                    <span className="font-semibold text-ink">Add {plural(names.length, 'type')} to your data model:</span> {listed}
                </p>
                <Button size="sm" variant="primary" leftIcon={Plus} loading={busy} onClick={add}>
                    Add to my data model
                </Button>
            </div>
            {error && (
                <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                    <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {error}
                </p>
            )}
        </div>
    )
}
