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
        <div aria-busy="true" aria-label="Loading the settings" className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
            <div className="hidden space-y-2 lg:block">
                <Skeleton className="mx-3 mb-3 h-3 w-24 rounded" />
                {[0, 1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-11 rounded-xl" />)}
            </div>
            <div className="min-w-0 space-y-5">
                <Skeleton className="h-10 rounded-xl lg:hidden" />
                {/* The hero's shape: headline and actions beside the compass, the search under them. */}
                <div className="rounded-3xl border border-glass-border/50 bg-canvas-elevated p-5 sm:p-7">
                    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,21rem)]">
                        <div className="min-w-0">
                            <Skeleton className="h-3.5 w-44 rounded" />
                            <Skeleton className="mt-3 h-8 w-full max-w-md rounded-lg" />
                            <Skeleton className="mt-3.5 h-4 w-full max-w-xl rounded" />
                            <Skeleton className="mt-2 h-4 w-2/3 max-w-lg rounded" />
                            <div className="mt-6 flex flex-wrap gap-2.5">
                                <Skeleton className="h-9 w-48 rounded-xl" />
                                <Skeleton className="h-9 w-44 rounded-xl" />
                            </div>
                        </div>
                        <Skeleton className="h-[62px] rounded-2xl" />
                        <div className="border-t border-glass-border/50 pt-5 lg:col-span-2">
                            <Skeleton className="h-10 w-full max-w-2xl rounded-xl" />
                        </div>
                    </div>
                </div>
                {[0, 1].map((i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
            </div>
        </div>
    )
}
