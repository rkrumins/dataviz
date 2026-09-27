/**
 * The entity drawer's header: the trail, the entity's type and name, the one-click lineage traces,
 * quick actions, and the View / Edit / JSON tabs — or, on the published graph, the way to a draft.
 */
import type { ComponentType } from 'react'
import {
  ArrowDownRight, ArrowUpLeft, Check, Code, Copy, ExternalLink, Eye, Focus, GitBranch, GitBranchPlus,
  Pencil, RotateCcw, Trash2,
} from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { DrawerHeader } from '../shell/DrawerShell'
import { DrawerTopBar, KindBadge } from '../shell/DrawerTopBar'

export type EntityTab = 'view' | 'edit' | 'json'

interface TraceAction {
  label: string
  hint: string
  icon: ComponentType<{ className?: string }>
  run?: (nodeId: string) => void
  /** Box, icon disc and text colours — the product's lineage direction pair, or purple for both. */
  tone: { box: string; disc: string; text: string; hint: string }
}

export function EntityHeader({
  nodeId, titleId, typeName, colors, confidence, title, technicalLine, isGhost, onRestore,
  onTraceUp, onTraceDown, onFullTrace, onFocusConnections, copiedUrn, onCopyUrn, externalUrl,
  editable, dirty, onStartEditing, onClose, onFocusNode,
}: {
  nodeId: string
  titleId: string
  typeName: string
  colors: { accent: string; bg: string; text: string }
  confidence?: number
  title: string
  technicalLine?: string
  isGhost: boolean
  onRestore: () => void
  onTraceUp?: (nodeId: string) => void
  onTraceDown?: (nodeId: string) => void
  onFullTrace?: (nodeId: string) => void
  onFocusConnections?: (nodeId: string) => void
  copiedUrn: boolean
  onCopyUrn: () => void
  externalUrl: string | null
  /** The Edit tab is offered. */
  editable: boolean
  dirty: boolean
  /** Offered instead of Edit on the published graph. */
  onStartEditing?: () => void
  onClose: () => void
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
}) {
  // Upstream and downstream wear the product's lineage direction pair (lib/lineageDirectionColors.ts)
  // — the canvas's ports, the lineage cards below, the Focus Lens and a trace.
  const traces: TraceAction[] = [
    { label: 'Root Cause', hint: 'Trace Upstream', icon: ArrowUpLeft, run: onTraceUp,
      tone: { box: 'bg-lineage-in/10 border-lineage-in/20 hover:bg-lineage-in/20', disc: 'bg-lineage-in/20 text-lineage-in', text: 'text-lineage-in', hint: 'text-lineage-in/70' } },
    { label: 'Impact', hint: 'Trace Downstream', icon: ArrowDownRight, run: onTraceDown,
      tone: { box: 'bg-lineage-out/10 border-lineage-out/20 hover:bg-lineage-out/20', disc: 'bg-lineage-out/20 text-lineage-out', text: 'text-lineage-out', hint: 'text-lineage-out/70' } },
    { label: 'Full Lineage', hint: 'Both Directions', icon: GitBranch, run: onFullTrace,
      tone: { box: 'bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/20', disc: 'bg-purple-500/20 text-purple-500', text: 'text-purple-600 dark:text-purple-400', hint: 'text-purple-500/70' } },
  ]
  // A trace takes the canvas over — a drawer move like any other, held while there are unsaved edits.
  const trace = (run: (id: string) => void) => useCanvasStore.getState().requestDrawerMove(() => run(nodeId))

  return (
    <DrawerHeader style={{ background: `linear-gradient(135deg, ${colors.accent}10 0%, transparent 60%)` }}>
      <DrawerTopBar
        onFocusNode={onFocusNode}
        onClose={onClose}
        closeLabel="Close entity details"
        badge={(
          <>
            <KindBadge label={typeName} bg={colors.bg} fg={colors.text} />
            {confidence !== undefined && (
              <span className={cn('text-xs font-medium tabular-nums',
                confidence >= 0.8 ? 'text-emerald-600 dark:text-emerald-400' : confidence >= 0.5 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')}>
                {Math.round(confidence * 100)}%
              </span>
            )}
          </>
        )}
      />

      {/* The name — Technical mode adds the fully-qualified identity underneath, and only when it
          says something the name does not. Focus lands here when the entity shown changes. */}
      <h2 id={titleId} tabIndex={-1} className={cn('text-xl font-display font-semibold text-ink leading-tight outline-none break-words', technicalLine ? 'mb-1' : 'mb-4')}>
        {title}
      </h2>
      {technicalLine && <p className="text-xs font-mono text-ink-muted break-all mb-4">{technicalLine}</p>}

      {isGhost ? (
        // Committed-deletion ghost → a Restore banner takes the place of the trace and edit actions.
        <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30">
          <div className="flex items-center gap-2 mb-1.5">
            <Trash2 className="w-4 h-4 text-rose-500" aria-hidden />
            <span className="text-sm font-semibold text-rose-600 dark:text-rose-400">Deleted in this draft</span>
          </div>
          <p className="text-xs text-ink-muted mb-3">
            Removed on this branch — it disappears once the draft merges. Restore to bring it back
            (nested under its parent when that parent still exists).
          </p>
          <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={onRestore}
            className="border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10">
            Restore
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 mb-4">
          {traces.map(({ label, hint, icon: Icon, run, tone }) => (
            <button
              key={label}
              type="button"
              disabled={!run}
              onClick={() => run && trace(run)}
              className={cn(
                'group flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-[background-color,transform] duration-150',
                'hover:-translate-y-px active:translate-y-0 motion-reduce:transform-none disabled:opacity-50 disabled:cursor-not-allowed',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40', tone.box,
              )}
            >
              <span className={cn('w-10 h-10 rounded-full flex items-center justify-center', tone.disc)}>
                <Icon className="w-5 h-5" aria-hidden />
              </span>
              <span className={cn('text-xs font-semibold', tone.text)}>{label}</span>
              <span className={cn('text-[10px]', tone.hint)}>{hint}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {onFocusConnections && !isGhost && (
          <Button size="sm" variant="subtle" leftIcon={Focus} onClick={() => onFocusConnections(nodeId)}>Focus</Button>
        )}
        <Button size="sm" variant="subtle" leftIcon={copiedUrn ? Check : Copy} onClick={onCopyUrn}>
          {copiedUrn ? 'Copied' : 'Copy URN'}
        </Button>
        {externalUrl && (
          <Button size="sm" variant="subtle" leftIcon={ExternalLink} onClick={() => window.open(externalUrl, '_blank', 'noopener')}>Open</Button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-4">
        <TabsList aria-label="Entity details" className="flex-1">
          <TabsTrigger value="view" icon={Eye}>View</TabsTrigger>
          {editable && (
            <TabsTrigger value="edit" icon={Pencil}
              badge={dirty ? <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="unsaved changes" /> : undefined}>
              Edit
            </TabsTrigger>
          )}
          <TabsTrigger value="json" icon={Code}>JSON</TabsTrigger>
        </TabsList>
        {!editable && onStartEditing && (
          // The published graph is never edited in place — say where editing happens.
          <Button variant="secondary" leftIcon={GitBranchPlus} onClick={onStartEditing}>Edit in a draft</Button>
        )}
      </div>
    </DrawerHeader>
  )
}
