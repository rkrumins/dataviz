/**
 * Updating a view that's already here: how the file and the view stand, Replace or Merge, and
 * what the import will change.
 *
 * Replace makes the view exactly the file. Merge keeps what changed here since the two last
 * agreed and lets the file win where both changed; it needs that last common version, so it is
 * only offered when both sides have moved.
 */
import { GitMerge, Replace } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UpdatePreview, UpdateStrategy } from '@/services/viewTransferApiService'
import { TONE_CHIP, UPDATE_STATUS_META, pluralize } from '../format'

export function UpdatePanel({ update, targetName, onStrategy }: {
  update: UpdatePreview
  targetName: string
  onStrategy: (strategy: UpdateStrategy) => void
}) {
  const status = UPDATE_STATUS_META[update.status]
  const diff = update.diff
  const a = diff.assignments
  const changes: string[] = []
  if (diff.layers.added.length) changes.push(pluralize(diff.layers.added.length, 'layer') + ' added')
  if (diff.layers.removed.length) changes.push(pluralize(diff.layers.removed.length, 'layer') + ' removed')
  if (diff.layers.changed.length) changes.push(pluralize(diff.layers.changed.length, 'layer') + ' changed')
  if (diff.layers.reordered) changes.push('layers reordered')
  if (a.added) changes.push(`${a.added.toLocaleString()} placed`)
  if (a.removed) changes.push(`${a.removed.toLocaleString()} unplaced`)
  if (a.moved) changes.push(`${a.moved.toLocaleString()} moved between layers`)
  if (a.modified) changes.push(`${a.modified.toLocaleString()} adjusted`)
  if (diff.settings.length) changes.push(pluralize(diff.settings.length, 'setting') + ' changed')

  return (
    <div className="rounded-2xl border border-glass-border overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3 bg-black/[0.015] dark:bg-white/[0.02] border-b border-glass-border/60">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold text-ink">Updating “{targetName}”</p>
            <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', TONE_CHIP[status.tone])}>{status.label}</span>
          </div>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {status.detail}
            {update.base ? ` They last matched at v${update.base.version}.` : ''}
            {update.targetHead ? ` It is at v${update.targetHead.version} here; this import becomes v${update.targetHead.version + 1}.` : ''}
          </p>
        </div>
      </div>

      {update.status !== 'up_to_date' && (
        <div className="grid grid-cols-2 gap-2 p-3">
          <StrategyCard active={update.strategy === 'replace'} icon={<Replace className="w-4 h-4" />}
            title="Replace" onClick={() => onStrategy('replace')}
            detail="Make the view exactly what the file holds. Its current design is kept as a version first." />
          <StrategyCard active={update.strategy === 'merge'} disabled={!update.mergeAvailable}
            icon={<GitMerge className="w-4 h-4" />} title="Merge" onClick={() => onStrategy('merge')}
            detail={update.mergeAvailable
              ? 'Keep what changed here and take what changed in the file. Where both changed the same thing, the file wins.'
              : update.status === 'diverged' ? 'Available when updating the same view.' : 'Only needed when both sides changed.'} />
        </div>
      )}

      <div className="px-4 pb-3 space-y-2">
        <p className="text-[11px] text-ink-secondary">
          <span className="font-semibold">What this changes here: </span>
          {diff.identical ? 'nothing — the design is identical.' : changes.join(', ') + '.'}
        </p>
        {update.conflicts.length > 0 && (
          <div className="rounded-lg bg-amber-500/[0.07] border border-amber-500/20 px-3 py-2">
            <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">
              Both sides changed {pluralize(update.conflicts.length, 'thing')}; the file’s version is used for each:
            </p>
            <p className="text-[10px] font-mono text-amber-700 dark:text-amber-300 mt-1 line-clamp-3">
              {update.conflicts.slice(0, 12).join(' · ')}{update.conflicts.length > 12 ? ` · +${update.conflicts.length - 12} more` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function StrategyCard({ active, disabled, icon, title, detail, onClick }: {
  active: boolean
  disabled?: boolean
  icon: React.ReactNode
  title: string
  detail: string
  onClick: () => void
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={active}
      className={cn('text-left rounded-xl border-2 px-3 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        active ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20' : 'border-glass-border hover:border-glass-border-hover')}>
      <span className="flex items-center gap-2">
        <span className={cn(active ? 'text-indigo-500' : 'text-ink-muted')}>{icon}</span>
        <span className="text-xs font-semibold text-ink">{title}</span>
      </span>
      <span className="block text-[11px] text-ink-muted mt-1 leading-relaxed">{detail}</span>
    </button>
  )
}
