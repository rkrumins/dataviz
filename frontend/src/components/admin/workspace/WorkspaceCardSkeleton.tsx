import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Shared shimmer primitive                                           */
/* ------------------------------------------------------------------ */

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded bg-black/5 dark:bg-white/5',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Grid card skeleton — matches WorkspaceCard layout                  */
/* ------------------------------------------------------------------ */

export function WorkspaceCardSkeleton() {
  return (
    <div className="border rounded-xl bg-canvas-elevated border-glass-border p-5 animate-pulse">
      {/* ── Icon + title row ── */}
      <div className="flex items-center gap-3 mb-4">
        <Shimmer className="w-10 h-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Shimmer className="h-4 w-32" />
          <Shimmer className="h-3 w-48" />
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="flex gap-4 mb-4">
        <Shimmer className="h-3 w-16" />
        <Shimmer className="h-3 w-16" />
        <Shimmer className="h-3 w-16" />
        <Shimmer className="h-3 w-16" />
      </div>

      {/* ── Pills row ── */}
      <div className="flex gap-1.5">
        <Shimmer className="h-5 w-20 rounded-lg" />
        <Shimmer className="h-5 w-20 rounded-lg" />
        <Shimmer className="h-5 w-20 rounded-lg" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  List row skeleton — matches workspace list row layout              */
/* ------------------------------------------------------------------ */

export function WorkspaceListRowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-glass-border animate-pulse">
      {/* ── Health dot ── */}
      <Shimmer className="w-2 h-2 rounded-full" />

      {/* ── Icon ── */}
      <Shimmer className="w-8 h-8 rounded-lg" />

      {/* ── Name + description ── */}
      <div className="flex-1 space-y-1.5">
        <Shimmer className="h-3.5 w-40" />
        <Shimmer className="h-2.5 w-56" />
      </div>

      {/* ── Stat columns ── */}
      <Shimmer className="h-3 w-12" />
      <Shimmer className="h-3 w-12" />
      <Shimmer className="h-3 w-12" />
      <Shimmer className="h-3 w-12" />
    </div>
  )
}
