/**
 * Small pieces the Subset Studio's steps share.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import type { PickOrigin } from '../../model/studioStore'

export interface StudioLayer {
  id: string
  name: string
  color?: string
}

const ORIGIN_LABEL: Record<PickOrigin, string> = {
  picked: 'Picked',
  'grown-up': 'Upstream',
  'grown-down': 'Downstream',
  path: 'On the path',
  outside: 'Outside view',
}

/** How an entity came into the subset. A plain pick says nothing. */
export function OriginBadge({ origin }: { origin: PickOrigin }) {
  if (origin === 'picked') return null
  return (
    <span
      className={cn(
        'flex-shrink-0 px-1.5 rounded-full text-[9.5px] font-semibold leading-4',
        origin === 'outside'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-accent-explore/15 text-accent-explore',
      )}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  )
}

export function LayerDot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2 h-2 flex-shrink-0 rounded-full border border-black/10 dark:border-white/10"
      style={{ backgroundColor: color ?? 'var(--nx-text-muted)' }}
    />
  )
}

/** A figure with its label — the Connect step's summary tiles. */
export function Tile({ value, label, tone = 'neutral', hint }: {
  value: ReactNode
  label: string
  tone?: 'neutral' | 'accent' | 'warning'
  hint?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 min-w-0',
        tone === 'accent' && 'border-accent-explore/30 bg-accent-explore/5',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/5',
        tone === 'neutral' && 'border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02]',
      )}
    >
      <div
        className={cn(
          'text-[18px] font-semibold leading-none tabular-nums',
          tone === 'accent' ? 'text-accent-explore' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-ink',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-ink-muted truncate" title={hint ?? label}>{label}</div>
    </div>
  )
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-1.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{children}</h4>
      {aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
    </div>
  )
}

export const QUIET_BUTTON =
  'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] font-medium text-ink-secondary ' +
  'hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed'

export const ICON_BUTTON =
  'p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40'
