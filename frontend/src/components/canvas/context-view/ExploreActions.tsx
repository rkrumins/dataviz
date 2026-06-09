/**
 * ExploreActions — the mode-specific Zone-3 controls for the default (read-only)
 * Explore mode. The always-visible visibility cluster (Lineage toggle + View
 * menu) lives in `ViewControls`; this owns the explore-only affordances: trace,
 * property browsing, and the single "Edit" hand-off into authoring.
 */

import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { TraceDepthControl } from './TraceDepthControl'
import { PropertyManagerButton } from '../property-manager/PropertyManagerButton'
import { EditModeButton } from '../EditModeButton'

export interface ExploreActionsProps {
  // Trace
  traceActive: boolean
  canTrace: boolean
  onStartTrace: () => void
  onExitTrace: () => void
  lineageReady: boolean
  traceUpstreamDepth: number
  traceDownstreamDepth: number
  onSetTraceDepth: (dir: 'upstream' | 'downstream', value: number) => void

  // Properties (browsing — read-only)
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Blueprint context chip
  activeContextModelName: string | null

  // Edit-mode entry
  onEnterEdit: () => void
}

export function ExploreActions({
  traceActive,
  canTrace,
  onStartTrace,
  onExitTrace,
  lineageReady,
  traceUpstreamDepth,
  traceDownstreamDepth,
  onSetTraceDepth,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  activeContextModelName,
  onEnterEdit,
}: ExploreActionsProps) {
  const { showToast } = useToast()

  const warnLineageNotReady = () => {
    showToast(
      'warning',
      'Trace is unavailable until lineage finishes loading. Please wait a moment.',
    )
  }

  return (
    <div className="flex items-center gap-3">
      {/* Trace toggle — three visual states (active / loading / ready) */}
      {traceActive ? (
        <button
          onClick={onExitTrace}
          title="Exit trace mode"
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-rose-500/20 to-rose-500/10 text-rose-700 border border-rose-400/50 hover:from-rose-500/30 hover:to-rose-500/20 hover:border-rose-400/70 dark:text-rose-200 dark:border-rose-400/40 dark:hover:border-rose-300/60 dark:hover:shadow-lg dark:hover:shadow-rose-500/20 transition-all duration-300"
        >
          <LucideIcons.X className="w-4 h-4" strokeWidth={2.4} />
          <span>Exit Trace</span>
          <span className="w-2 h-2 rounded-full bg-rose-500 dark:bg-rose-300 dark:shadow-lg dark:shadow-rose-300/60 animate-pulse" />
        </button>
      ) : !lineageReady ? (
        <button
          onClick={warnLineageNotReady}
          aria-busy="true"
          title="Lineage data is still loading — Trace will become available once it finishes"
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 cursor-wait',
            'bg-gradient-to-r from-accent-lineage/12 to-purple-500/[0.06] text-accent-lineage/85 border border-accent-lineage/30',
            'dark:from-accent-lineage/18 dark:to-purple-500/10 dark:text-accent-lineage dark:border-accent-lineage/25',
            'shadow-sm shadow-accent-lineage/10',
          )}
        >
          <LucideIcons.Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.4} />
          <span>Loading lineage…</span>
          <span className="w-2 h-2 rounded-full bg-accent-lineage dark:shadow-lg dark:shadow-accent-lineage/60 animate-pulse" aria-hidden />
        </button>
      ) : (
        <button
          onClick={canTrace ? onStartTrace : undefined}
          disabled={!canTrace}
          title={canTrace ? 'Trace lineage of selected entity' : 'Select a single entity to trace its lineage'}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300',
            canTrace
              ? 'bg-gradient-to-r from-accent-lineage/20 to-purple-500/10 text-accent-lineage border border-accent-lineage/40 hover:from-accent-lineage/30 hover:to-purple-500/20 hover:border-accent-lineage/60 dark:hover:shadow-lg dark:hover:shadow-accent-lineage/20'
              : 'bg-black/[0.03] border border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/40 cursor-not-allowed',
          )}
        >
          <LucideIcons.Workflow className="w-4 h-4" strokeWidth={2.2} />
          <span>Trace Lineage</span>
        </button>
      )}

      {traceActive && (
        <TraceDepthControl
          upstreamDepth={traceUpstreamDepth}
          downstreamDepth={traceDownstreamDepth}
          onChange={onSetTraceDepth}
        />
      )}

      {/* Properties — browsing (read-only) */}
      {onTogglePropertyManager && (
        <PropertyManagerButton open={propertyManagerOpen} onToggle={onTogglePropertyManager} />
      )}

      {/* Blueprint context chip */}
      {activeContextModelName && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-500/[0.08] border border-purple-500/25 dark:border-purple-500/20"
          title={activeContextModelName}
        >
          <LucideIcons.BookMarked className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
          <span className="text-xs font-medium text-purple-700 dark:text-purple-300 truncate max-w-[140px]">
            {activeContextModelName}
          </span>
        </div>
      )}

      <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

      {/* Edit entry — the single, deliberate gateway into authoring */}
      <EditModeButton onClick={onEnterEdit} />
    </div>
  )
}
