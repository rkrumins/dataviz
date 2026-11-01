/**
 * ForkStatusBits — what every fork surface says the same way (a data source's Forks list, a fork's
 * own strip): how far a fork is from its parent, when the server recommends an update, and that forks
 * are turned off.
 */
import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { ForkSummary } from '@/services/versioningApiService'

type Distance = Pick<ForkSummary, 'ahead' | 'behind' | 'countsCapped'>

/** "4 ahead · 2 behind": the fork's own changes since it last merged into its parent (or since it
 *  was made), and its parent's it has not taken in. A count that stopped at the ceiling — the larger
 *  one — reads "200,000+". Nothing for a fork in the trash, which says neither. */
export function ForkDistance({ fork, className }: { fork: Distance; className?: string }) {
  if (fork.ahead == null || fork.behind == null) return null
  const top = Math.max(fork.ahead, fork.behind)
  const count = (n: number) => `${n.toLocaleString()}${fork.countsCapped && n === top ? '+' : ''}`
  return (
    <HoverTip
      className="inline-flex"
      label="Ahead: changes made on the fork since it last merged into its parent"
      detail="Behind: changes in its parent the fork hasn’t taken in — Update from parent takes them"
    >
      <span className={cn('tabular-nums', className)}>{count(fork.ahead)} ahead · {count(fork.behind)} behind</span>
    </HoverTip>
  )
}

/** The server recommends an update: the parent changed a lot since the fork last took its changes,
 *  or the fork is too far from it to read through it, so its reads are slower until it updates. */
export function UpdateRecommendedHint({ fork, className }: {
  fork: Pick<ForkSummary, 'updateRecommended' | 'readsFrom'>
  className?: string
}) {
  if (!fork.updateRecommended) return null
  return (
    <p className={cn('flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400', className)}>
      <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
      {fork.readsFrom === 'postgres'
        ? 'Update recommended: it is too far from its parent to read quickly, so it reads slower until it takes its parent’s changes.'
        : 'Update recommended: its parent has changed a lot since it last took its changes.'}
    </p>
  )
}

/** While forks are off a fork is read-only: it reads, and goes to the trash and back, but nothing new
 *  happens in it. The server's words, so the screen and a refusal say the same. */
export function ForksOffNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-[11px] text-ink-muted', className)}>
      <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
      Forks are turned off for this deployment, so they can be read but not changed. An administrator can
      turn them on under Admin → Features.
    </p>
  )
}
