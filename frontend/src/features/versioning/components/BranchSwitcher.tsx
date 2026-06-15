/**
 * BranchSwitcher — the canvas-toolbar control for "which branch am I on".
 *
 * Resolves the active data source to its versioned graph (syncing the result into
 * `branchStore`), lists main + open drafts with a per-draft up-to-date status, and lets the
 * user create a NAMED draft, switch between them, or pull the latest main into a behind draft.
 * Shared across all three canvases via the toolbars. Renders nothing when the data source has
 * no versioned graph (the common case until a graph is created).
 */
import { useEffect, useRef, useState } from 'react'
import { GitBranch, Check, Plus, ChevronDown, Loader2, GitCommitHorizontal, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useActiveView } from '@/store/schema'
import { useBranches, useOpenDraft, useResolveGraph } from '../hooks/useVersioning'
import { useBranchDeepLink } from '../hooks/useBranchDeepLink'
import type { Branch } from '@/services/versioningApiService'
import { PullLatestButton } from './PullLatestButton'
import { BranchSettingsModal } from './BranchSettingsModal'

interface BranchSwitcherProps {
  workspaceId: string
  dataSourceId: string | null
  className?: string
}

export function BranchSwitcher({ workspaceId, dataSourceId, className }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [settingsBranch, setSettingsBranch] = useState<Branch | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)

  const resolve = useResolveGraph(workspaceId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null
  const mainHead = resolve.data?.mainHeadCommitSeq ?? 0
  // The view the draft is created from — attributes the draft's commits to it so the view's History
  // ("This view") and the per-draft timeline populate.
  const originatingViewId = useActiveView()?.id ?? null
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

  // Deep-link: apply ?branch=<id> on load (permission-gated) + keep the URL in step with the
  // active branch, so a view+branch is a shareable link.
  useBranchDeepLink({
    enabled: !!graphId && !!dataSourceId,
    branches: branchesQ.data,
    currentBranchId,
    switchToDraft,
  })

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
  const isBehind = (b: Branch) => (b.baseCommitSeq ?? 0) < mainHead

  const handleCreate = () => {
    openDraft.mutate(
      { name: newName.trim() || undefined, originatingViewId: originatingViewId ?? undefined },
      {
        onSuccess: (r) => {
          switchToDraft(r.branchId, originatingViewId)
          setOpen(false)
          showToast('success', `Draft "${newName.trim() || 'Untitled'}" created — edits stay isolated until merged.`)
          setNewName('')
          setCreating(false)
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
        {!onMain && activeDraft && isBehind(activeDraft) && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Behind main — pull latest before merging" />
        )}
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-80 z-50 rounded-xl border border-glass-border bg-canvas-elevated shadow-glass-lg overflow-hidden animate-fade-in">
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
            {drafts.map((b) => {
              const behind = isBehind(b)
              return (
                <BranchRow
                  key={b.branchId}
                  icon={<GitBranch className="w-4 h-4 text-amber-500" />}
                  title={b.name || 'Untitled draft'}
                  subtitle={draftSubtitle(b)}
                  active={b.branchId === currentBranchId}
                  status={behind ? 'behind' : 'up-to-date'}
                  pullSlot={canManage ? (
                    <PullLatestButton
                      variant="row" wsId={workspaceId} graphId={graphId ?? ''}
                      branchId={b.branchId} behind={behind}
                    />
                  ) : undefined}
                  settingsSlot={canManage ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); setSettingsBranch(b); setOpen(false) }}
                      title="Branch settings — rename, describe, share link"
                      className="shrink-0 p-1 rounded-md text-ink-muted/70 hover:text-ink hover:bg-canvas-base transition-colors"
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                    </button>
                  ) : undefined}
                  onClick={() => {
                    switchToDraft(b.branchId, b.originatingViewId ?? null)
                    setOpen(false)
                  }}
                />
              )
            })}
            {branchesQ.isLoading && (
              <div className="px-3 py-2 flex items-center gap-2 text-xs text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading branches…
              </div>
            )}
          </div>
          {canManage && (
            creating ? (
              <div className="flex items-center gap-2 px-3 py-2.5 border-t border-glass-border">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate()
                    if (e.key === 'Escape') { setCreating(false); setNewName('') }
                  }}
                  placeholder="Draft name (optional)"
                  className="flex-1 min-w-0 px-2 py-1 rounded-md bg-canvas-overlay border border-glass-border text-sm text-ink outline-none focus:border-accent-lineage"
                />
                <button
                  onClick={handleCreate}
                  disabled={openDraft.isPending}
                  className="shrink-0 px-2.5 py-1 rounded-md text-sm font-medium text-accent-lineage hover:bg-canvas-overlay disabled:opacity-50"
                >
                  {openDraft.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-glass-border text-sm font-medium text-accent-lineage hover:bg-canvas-overlay transition-colors"
              >
                <Plus className="w-4 h-4" />
                New draft
              </button>
            )
          )}
        </div>
      )}

      {settingsBranch && graphId && (
        <BranchSettingsModal
          wsId={workspaceId}
          graphId={graphId}
          viewId={originatingViewId}
          branch={settingsBranch}
          onClose={() => setSettingsBranch(null)}
        />
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
  status,
  pullSlot,
  settingsSlot,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  active: boolean
  status?: 'behind' | 'up-to-date'
  pullSlot?: React.ReactNode
  settingsSlot?: React.ReactNode
  onClick: () => void
}) {
  return (
    <div className="w-full flex items-center gap-1 pr-2 hover:bg-canvas-overlay transition-colors">
      <button onClick={onClick} className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 text-left">
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-ink truncate">{title}</span>
          <span className="block text-[11px] text-ink-muted truncate">{subtitle}</span>
        </span>
        {status === 'behind' && (
          <span className="shrink-0 text-[10px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">Behind</span>
        )}
        {active && <Check className="w-4 h-4 text-accent-lineage shrink-0" />}
      </button>
      {pullSlot}
      {settingsSlot}
    </div>
  )
}
