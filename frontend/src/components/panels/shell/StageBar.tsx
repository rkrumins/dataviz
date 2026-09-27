/**
 * StageBar — a drawer's footer while editing: where the edit stands, Cancel, and "Stage changes"
 * (its shortcut in the tooltip). Staging records the edit for Review & Save; nothing is saved
 * until then.
 */
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { formatShortcut, isApplePlatform } from '@/lib/platform'

export function StageBar({ dirty, justStaged, onCancel, onStage }: {
  dirty: boolean
  /** The edit was staged a moment ago — say so. */
  justStaged: boolean
  onCancel: () => void
  onStage: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span role="status" className="min-w-0 flex items-center gap-1.5 text-xs">
        {dirty ? (
          <><AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-500" aria-hidden /><span className="text-ink-secondary truncate">Unsaved changes</span></>
        ) : justStaged ? (
          <><CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" aria-hidden /><span className="text-ink-secondary truncate">Staged for review</span></>
        ) : (
          <span className="text-ink-muted truncate">No changes yet</span>
        )}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <HoverTip label="Stage changes" detail="Kept for Review & Save — nothing is saved yet." shortcut={formatShortcut('mod+s')} className="inline-flex">
          <Button variant="primary" disabled={!dirty} onClick={onStage}
            aria-keyshortcuts={isApplePlatform() ? 'Meta+S' : 'Control+S'}>
            Stage changes
          </Button>
        </HoverTip>
      </div>
    </div>
  )
}
