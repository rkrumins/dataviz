import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Shared shimmer primitive                                           */
/* ------------------------------------------------------------------ */

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg bg-black/[0.06] dark:bg-white/[0.06]',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Card skeleton — matches ExplorerViewCard glass-panel layout        */
/* ------------------------------------------------------------------ */

export function ExplorerCardSkeleton() {
  return (
    <div
      className={cn(
        'glass-panel relative flex flex-col rounded-2xl border border-glass-border p-5 overflow-hidden',
      )}
    >
      {/* ── Header: icon container + title ── */}
      <div className="flex items-center gap-3 mb-3">
        <Shimmer className="w-9 h-9 shrink-0 rounded-xl" />
        <Shimmer className="h-4 flex-1 max-w-[60%]" />
      </div>

      {/* ── Badges: workspace pill + visibility pill ── */}
      <div className="flex items-center gap-2 mb-3">
        <Shimmer className="h-5 w-24 rounded-full" />
        <Shimmer className="h-5 w-20 rounded-full" />
      </div>

      {/* ── Description: 2 lines ── */}
      <div className="flex flex-col gap-1.5 mb-3">
        <Shimmer className="h-3 w-full" />
        <Shimmer className="h-3 w-3/4" />
      </div>

      {/* ── Tags ── */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        <Shimmer className="h-5 w-14 rounded-full" />
        <Shimmer className="h-5 w-16 rounded-full" />
        <Shimmer className="h-5 w-12 rounded-full" />
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Footer ── */}
      <div className="flex items-center gap-2 border-t border-glass-border pt-3 mt-1">
        {/* Avatar */}
        <Shimmer className="w-6 h-6 rounded-full" />
        {/* Favourite count */}
        <Shimmer className="h-3 w-10" />
        {/* Timestamp */}
        <Shimmer className="h-3 w-14" />

        {/* Action placeholders — pushed right */}
        <div className="ml-auto flex items-center gap-1">
          <Shimmer className="w-7 h-7 rounded-lg" />
          <Shimmer className="w-7 h-7 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  List row skeleton — matches ExplorerListRow grid layout            */
/* ------------------------------------------------------------------ */

export function ExplorerListRowSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_140px_100px_36px_120px_60px_80px_72px] items-center gap-3 rounded-xl px-3 py-2.5">
      {/* Name + icon container */}
      <div className="flex items-center gap-3">
        <Shimmer className="w-7 h-7 shrink-0 rounded-lg" />
        <Shimmer className="h-4 flex-1 max-w-[70%]" />
      </div>
      {/* Workspace pill */}
      <Shimmer className="h-5 w-24 rounded-full" />
      {/* Type label */}
      <Shimmer className="h-3 w-14" />
      {/* Visibility icon */}
      <Shimmer className="h-3.5 w-3.5 rounded" />
      {/* Owner */}
      <Shimmer className="h-3 w-16" />
      {/* Likes */}
      <Shimmer className="h-3 w-8" />
      {/* Updated */}
      <Shimmer className="h-3 w-14" />
      {/* Actions */}
      <div className="flex items-center gap-0.5">
        <Shimmer className="w-7 h-7 rounded-lg" />
        <Shimmer className="w-7 h-7 rounded-lg" />
      </div>
    </div>
  )
}
