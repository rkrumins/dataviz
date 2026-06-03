/**
 * Loading skeleton shown inside the Results pane while a query is in
 * flight. Kept compact — three faded cards with a pulse animation —
 * since the panel chrome (header, workspace, footer) all stay mounted.
 */
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'


export function RunningSkeleton({ label = 'Searching your graph…' }: { label?: string }) {
    return (
        <div className="flex flex-col p-4 gap-3">
            <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 text-accent-lineage animate-spin" />
                {label}
            </div>
            <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className={cn(
                            "rounded-xl border border-glass-border/40",
                            "bg-gradient-to-br from-canvas-elevated/40 to-canvas-elevated/20",
                            "p-3 h-[72px] animate-pulse",
                        )}
                        style={{ animationDelay: `${i * 120}ms`, opacity: 1 - i * 0.15 }}
                    >
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-glass/40" />
                            <div className="flex-1 space-y-1.5">
                                <div className="h-3 w-32 rounded bg-glass/40" />
                                <div className="h-2 w-16 rounded bg-glass/30" />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
