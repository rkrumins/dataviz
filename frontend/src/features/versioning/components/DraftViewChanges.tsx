/**
 * What a draft changes in views, beside its graph changes: views it creates (imports waiting to
 * go live), imports staged for views here, and layer edits. They go live when the draft is
 * published or its review request merges. Views the reader can't open are counted, not named.
 */
import { useNavigate } from 'react-router-dom'
import { FileInput, Layers, PlusCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { percent, pluralize } from '@/features/view-transfer/format'
import type { BranchViewChange, BranchViewChanges } from '@/services/versioningApiService'

const KIND = {
  create: { icon: PlusCircle, tone: 'text-emerald-500', label: 'New view' },
  update: { icon: FileInput, tone: 'text-indigo-500', label: 'Imported' },
  layout: { icon: Layers, tone: 'text-amber-500', label: 'Layers edited' },
} as const

function detail(c: BranchViewChange): string {
  const parts: string[] = []
  if (c.origin) {
    parts.push(`from ${c.origin.environment ?? 'a file'}${c.origin.version ? ` v${c.origin.version}` : ''}`)
  }
  if (c.matchRate !== null && c.matchRate !== undefined) parts.push(`${percent(c.matchRate)} matched`)
  if (c.change === 'create' && c.stats) {
    parts.push(`${pluralize(c.stats.layers ?? 0, 'layer')}, ${(c.stats.assignments ?? 0).toLocaleString()} placements`)
    parts.push(c.goesLiveAs === 'workspace' ? 'goes live shared with its workspace' : 'goes live private')
  }
  if (c.diff && !c.diff.identical) {
    const l = c.diff.layers
    const a = c.diff.assignments
    const layerChanges = l.added.length + l.removed.length + l.changed.length
    if (layerChanges) parts.push(pluralize(layerChanges, 'layer change'))
    const moves = [a.added && `${a.added.toLocaleString()} placed`, a.removed && `${a.removed.toLocaleString()} unplaced`,
      a.moved && `${a.moved.toLocaleString()} moved`].filter(Boolean)
    if (moves.length) parts.push(moves.join(', '))
    if (c.diff.metadata.some(m => m.field === 'name')) parts.push('renamed')
  }
  return parts.join(' · ')
}

export function DraftViewChanges({ changes, branchId, onNavigate, className }: {
  changes: BranchViewChanges
  /** The draft they're in: "Open" shows a view on it. */
  branchId: string
  /** Called before navigating away (to close a dialog or drawer). */
  onNavigate?: () => void
  className?: string
}) {
  const navigate = useNavigate()
  if (!changes.views.length && !changes.hidden) return null
  return (
    <div className={cn('rounded-xl border border-glass-border divide-y divide-glass-border/60', className)}>
      {changes.views.map(c => {
        const kind = KIND[c.change]
        const Icon = kind.icon
        return (
          <div key={c.viewId} className="flex items-center gap-2.5 px-3 py-2">
            <Icon className={cn('w-4 h-4 shrink-0', kind.tone)} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-ink truncate">
                <span className="text-ink-muted font-normal">{kind.label}: </span>{c.name}
              </p>
              <p className="text-[11px] text-ink-muted truncate">{detail(c) || 'Changed in this draft'}</p>
            </div>
            <button type="button" onClick={() => { onNavigate?.(); navigate(`/views/${c.viewId}?branch=${branchId}`) }}
              className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
              Open
            </button>
          </div>
        )
      })}
      {changes.hidden > 0 && (
        <p className="px-3 py-2 text-[11px] text-ink-muted">
          {changes.views.length ? 'And ' : ''}{pluralize(changes.hidden, 'change')} to views you can’t open.
        </p>
      )}
    </div>
  )
}
