/**
 * BranchSwitcher — the canvas-toolbar control for "which branch am I on".
 *
 * Resolves the active data source to its versioned graph (syncing the result into
 * `branchStore`), lists main + open drafts, and lets the user switch or open a new
 * draft. Shared across all three canvases via the toolbars. Renders nothing when the
 * data source has no versioned graph (the common case until a graph is created).
 */
import { useEffect, useRef, useState } from 'react'
import { GitBranch, Check, Plus, ChevronDown, Loader2, GitCommitHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useBranches, useOpenDraft, useResolveGraph } from '../hooks/useVersioning'
import type { Branch } from '@/services/versioningApiService'

interface BranchSwitcherProps {
  workspaceId: string
  dataSourceId: string | null
  className?: string
}

export function BranchSwitcher({ workspaceId, dataSourceId, className }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)

  const resolve = useResolveGraph(workspaceId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null
  const branchesQ = useBranches(workspaceId, graphId)
  const openDraft = useOpenDraft(workspaceId, graphId ?? '')

  const currentBranchId = useBranchStore((s) => s.currentBranchId)
  const setResolved = useBranchStore((s) => s.setResolved)
  const switchToMain = useBranchStore((s) => s.switchToMain)
  const switchToDraft = useBranchStore((s) => s.switchToDraft)

  // Sync the resolve result into the shared branch store (scoped to this data source).
  useEffect(() => {
    if (resolve.data && dataSourceId) {
      setResolved({ workspaceId, dataSourceId }, resolve.data)
    }
  }, [resolve.data, workspaceId, dataSourceId, setResolved])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // No versioned graph for this data source → nothing to switch.
  if (!dataSourceId || (resolve.isError && !graphId) || (!resolve.isLoading && !graphId)) {
    return null
  }

  const drafts = (branchesQ.data ?? []).filter((b) => b.kind !== 'main' && b.status === 'open')
  const onMain = !currentBranchId
  const activeDraft = drafts.find((b) => b.branchId === currentBranchId)

  const handleOpenDraft = () => {
    openDraft.mutate(
      {},
      {
        onSuccess: (r) => {
          switchToDraft(r.branchId)
          setOpen(false)
          showToast('success', 'Draft created — your edits stay isolated until you publish.')
        },
        onError: (e) => showToast('error', (e as Error).message),
      },
    )
  }

  const label = onMain ? 'Main' : activeDraft?.name || 'Draft'

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors',
          'bg-canvas-elevated border border-glass-border hover:bg-canvas-overlay',
          !onMain && 'text-amber-500 border-amber-500/30',
        )}
        title={onMain ? 'On main' : `On draft: ${label}`}
      >
        <GitBranch className={cn('w-4 h-4', onMain ? 'text-ink-muted' : 'text-amber-500')} />
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-72 z-50 rounded-xl border border-glass-border bg-canvas-elevated shadow-glass-lg overflow-hidden animate-fade-in">
          <div className="px-3 py-2 border-b border-glass-border">
            <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Branch</p>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            <BranchRow
              icon={<GitCommitHorizontal className="w-4 h-4 text-ink-muted" />}
              title="Main"
              subtitle="The published graph"
              active={onMain}
              onClick={() => {
                switchToMain()
                setOpen(false)
              }}
            />
            {drafts.map((b) => (
              <BranchRow
                key={b.branchId}
                icon={<GitBranch className="w-4 h-4 text-amber-500" />}
                title={b.name || 'Untitled draft'}
                subtitle={draftSubtitle(b)}
                active={b.branchId === currentBranchId}
                onClick={() => {
                  switchToDraft(b.branchId, b.originatingViewId ?? null)
                  setOpen(false)
                }}
              />
            ))}
            {branchesQ.isLoading && (
              <div className="px-3 py-2 flex items-center gap-2 text-xs text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading branches…
              </div>
            )}
          </div>
          {canManage && (
            <button
              onClick={handleOpenDraft}
              disabled={openDraft.isPending}
              className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-glass-border text-sm font-medium text-accent-lineage hover:bg-canvas-overlay transition-colors disabled:opacity-50"
            >
              {openDraft.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New draft
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function draftSubtitle(b: Branch): string {
  const who = b.owner ? `by ${b.owner.split('@')[0]}` : ''
  return [b.originatingViewId ? 'from a view' : '', who].filter(Boolean).join(' · ') || 'draft'
}

function BranchRow({
  icon,
  title,
  subtitle,
  active,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-canvas-overlay transition-colors"
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-ink truncate">{title}</span>
        <span className="block text-[11px] text-ink-muted truncate">{subtitle}</span>
      </span>
      {active && <Check className="w-4 h-4 text-accent-lineage shrink-0" />}
    </button>
  )
}
