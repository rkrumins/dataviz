/**
 * What a settings page shows while it can't show its settings: their shape while they load, and
 * what failed with a retry. Shared by the platform's section and a workspace's tab.
 */
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { settingsError } from '@/services/settingsService'

export function Failed({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
    return (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-5 py-4">
            <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t read {what}: {settingsError(error).message}</p>
            <Button size="sm" leftIcon={RotateCw} onClick={onRetry}>Try again</Button>
        </div>
    )
}

export function SettingsSkeleton() {
    return (
        <div aria-busy="true" aria-label="Loading the settings" className="grid gap-10 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
            <div className="hidden space-y-2 lg:block">{[0, 1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-10 rounded-xl" />)}</div>
            <div className="space-y-4">
                <Skeleton className="h-9 w-80 max-w-full rounded-xl" />
                <Skeleton className="h-10 w-full max-w-2xl rounded-xl" />
                <Skeleton className="h-24 rounded-2xl" />
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
            </div>
        </div>
    )
}
