/**
 * Loading states shaped like what is arriving.
 *
 * These tabs said "Loading rules…" in centred grey text, which tells you
 * the page is not broken and nothing else. The house idiom everywhere else
 * — AdminUsers, RegistryConnections, the dashboard — is `animate-pulse`
 * over blocks laid out roughly like the eventual content, so the render
 * settles into place instead of replacing one thing with a different one.
 *
 * Deliberately approximate. A skeleton that matched exactly would have to
 * be kept in step with the real layout forever; one that matches *roughly*
 * costs nothing when the layout drifts and still does its job, which is to
 * stop the page jumping.
 */
import { cn } from '@/lib/utils'

function Block({ className }: { className?: string }) {
    return <div className={cn('rounded bg-black/5 dark:bg-white/5', className)} />
}

function Card({ className }: { className?: string }) {
    return (
        <div className={cn(
            'rounded-xl border border-glass-border bg-glass-base/30',
            className,
        )} />
    )
}

/** A stack of cards — the connection list, the rules list. */
export function SsoListSkeleton({ rows = 3 }: { rows?: number }) {
    return (
        <div className="space-y-3 animate-pulse" aria-hidden="true">
            {Array.from({ length: rows }, (_, i) => (
                <Card key={i} className="h-[92px]" />
            ))}
        </div>
    )
}

/** The composer card above a short list. */
export function SsoMappingsSkeleton() {
    return (
        <div className="space-y-5 animate-pulse" aria-hidden="true">
            <Card className="h-[188px]" />
            <div className="space-y-3">
                <Block className="h-4 w-28" />
                <Card className="h-[104px]" />
                <Card className="h-[76px]" />
            </div>
        </div>
    )
}

/** Three labelled groups of switch rows. */
export function SsoSettingsSkeleton() {
    return (
        <div className="space-y-6 animate-pulse" aria-hidden="true">
            {[2, 1, 1].map((count, g) => (
                <div key={g} className="space-y-2.5">
                    <Block className="h-4 w-40" />
                    {Array.from({ length: count }, (_, i) => (
                        <Card key={i} className="h-[116px]" />
                    ))}
                </div>
            ))}
        </div>
    )
}

/**
 * A live region announcing what the pulsing blocks cannot.
 *
 * The skeletons are `aria-hidden` — decorative shapes are noise to a
 * screen reader — so the fact that something is loading has to be said
 * somewhere, once.
 */
export function SsoLoading({ label }: { label: string }) {
    return <span className="sr-only" role="status">{label}</span>
}
