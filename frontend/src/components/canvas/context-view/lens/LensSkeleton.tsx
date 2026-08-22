/**
 * LensSkeleton — the picture's ghost, where the cards will land.
 *
 * Between opening Focus and the first page landing the board used to be
 * an empty field of dots with a capsule at the top — correct, and read by
 * more than one person as "nothing is happening" (2026-08-22). This is
 * the shape of the answer drawn before the answer: ghost partner cards
 * on the upstream side, a ghost focal frame with a header and rows in the
 * middle, ghost partners downstream, dashed ghost wires between them,
 * all of it shimmering. The real cards take its place the moment they
 * exist (the host unmounts it), so it never lies about content — it
 * carries no names and no numbers, only the geometry every Focus picture
 * shares: sources → focus → consumers.
 *
 * Pure presentation: no React Flow, no store, `pointer-events: none`,
 * `aria-hidden` (the capsule is the spoken status). Reduced motion stops
 * the shimmer; the shape stays.
 */
import { cn } from '@/lib/utils'

const ghostCard = 'nx-skeleton rounded-xl border border-black/[0.09] dark:border-white/[0.1] bg-black/[0.05] dark:bg-white/[0.06]'

function GhostCard({ className }: { className?: string }) {
  return (
    <div className={cn(ghostCard, 'w-[200px] h-[58px] px-3 py-2.5 flex items-center gap-2.5', className)}>
      <span className="w-7 h-7 rounded-md bg-black/[0.08] dark:bg-white/[0.1] flex-none" />
      <span className="flex-1 min-w-0 space-y-1.5">
        <span className="block h-2.5 w-3/4 rounded bg-black/[0.11] dark:bg-white/[0.13]" />
        <span className="block h-2 w-1/2 rounded bg-black/[0.07] dark:bg-white/[0.09]" />
      </span>
    </div>
  )
}

function GhostFocal() {
  return (
    <div className={cn(ghostCard, 'w-[300px] p-3 space-y-2.5 border-accent-lineage/25 bg-accent-lineage/[0.04]')}>
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-md bg-accent-lineage/20 flex-none" />
        <span className="h-3 w-2/3 rounded bg-accent-lineage/20" />
      </div>
      <span className="block h-2 w-1/2 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
      {[0, 1, 2].map(i => (
        <div key={i} className="h-10 rounded-lg border border-black/[0.05] dark:border-white/[0.07] bg-black/[0.03] dark:bg-white/[0.04] px-2.5 flex items-center gap-2">
          <span className="w-5 h-5 rounded bg-black/[0.06] dark:bg-white/[0.08] flex-none" />
          <span className="h-2 rounded bg-black/[0.07] dark:bg-white/[0.09]" style={{ width: `${55 - i * 9}%` }} />
        </div>
      ))}
    </div>
  )
}

/** Three dashed ghost wires fanning from one side into the other. */
function GhostWires({ flip = false }: { flip?: boolean }) {
  const ys = [16, 50, 84]
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn('w-[120px] h-[200px] flex-none text-accent-lineage/40', flip && '-scale-x-100')}
    >
      {ys.map(y => (
        <path
          key={y}
          d={`M 0 ${y} C 50 ${y}, 50 50, 100 50`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          className="nx-skeleton-wire"
        />
      ))}
    </svg>
  )
}

export function LensSkeleton() {
  return (
    <div
      data-testid="lens-skeleton"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
    >
      <div className="flex items-center gap-0">
        <div className="flex flex-col gap-3">
          <GhostCard />
          <GhostCard className="opacity-80" />
          <GhostCard className="opacity-60" />
        </div>
        <GhostWires />
        <GhostFocal />
        <GhostWires flip />
        <div className="flex flex-col gap-3">
          <GhostCard />
          <GhostCard className="opacity-80" />
          <GhostCard className="opacity-60" />
        </div>
      </div>
    </div>
  )
}
