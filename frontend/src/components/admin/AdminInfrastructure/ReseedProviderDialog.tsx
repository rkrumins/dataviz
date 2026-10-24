/**
 * ReseedProviderDialog — reseed every versioned graph on one FalkorDB
 * provider from Postgres, after its instance was restored or rebuilt and its
 * keys may hold less than the platform's watermarks say.
 *
 * The confirm first asks the server how many graphs the reset would reseed
 * (a dry run of the same reset), so the operator sees the blast radius
 * before anything changes.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { useAppNotifications } from '@/components/ui/notifications'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { systemStatusService, type GraphProvider } from '@/services/systemStatusService'

const graphs = (n: number) => `${n} versioned graph${n === 1 ? '' : 's'}`

export function ReseedProviderDialog({ provider, onClose }: { provider: GraphProvider; onClose: () => void }) {
    const { notify } = useAppNotifications()
    const count = useQuery({
        queryKey: ['admin', 'watermarkReset', provider.id],
        queryFn: () => systemStatusService.resetWatermarks(provider.id, { dryRun: true }),
        gcTime: 0,
    })
    const reset = useMutation({
        mutationFn: () => systemStatusService.resetWatermarks(provider.id),
        onSuccess: (res) => {
            notify('success', `${graphs(res.graphsReset ?? 0)} on ${provider.name} will be reseeded from Postgres.`)
            onClose()
        },
        onError: (e) => notify('error', (e as Error).message),
    })
    const n = count.data?.graphsToReset

    return (
        <ConfirmDialog
            open
            title="Reseed from Postgres?"
            message={
                count.isPending ? `Counting the versioned graphs on ${provider.name}…`
                    : n == null ? `Could not count the versioned graphs on ${provider.name}: ${(count.error as Error | null)?.message ?? 'unknown error'}`
                        : `${graphs(n)} on ${provider.name} will be reseeded from Postgres. Use this after its FalkorDB `
                            + 'instance was restored or rebuilt. Reads come from Postgres until each graph catches up.'
            }
            confirmLabel={n != null ? `Reseed ${n} graph${n === 1 ? '' : 's'}` : 'Reseed'}
            confirmIcon={RotateCcw}
            onConfirm={() => reset.mutate()}
            onCancel={onClose}
            loading={count.isPending || reset.isPending}
        />
    )
}
