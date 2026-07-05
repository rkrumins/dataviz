/**
 * BranchManager — a premium slide-over for overseeing every draft in plain language.
 *
 * Opened from the BranchSwitcher ("Manage all drafts"). Lists open drafts with status, owner and
 * last activity, and exposes the full lifecycle per draft: Open, Get latest updates, Publish,
 * Settings, Archive. All wording comes from `branchVocab` (presentational only — no API/URL change).
 * Reuses the existing mutations and the CommitDialog/BranchSettingsModal/PullLatestButton so the
 * behaviour matches the rest of the app.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Search, Plus, GitBranch, Loader2, Settings2, Archive, Rocket,
  ArrowRight, Eye, Inbox, Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useToast } from '@/components/ui/toast'
import type { Branch } from '@/services/versioningApiService'
import {
  useBranches, useOpenDraft, useAbandonDraft, useDiffVsMain,
} from '../hooks/useVersioning'
import { fromDiffVsMain } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { BRANCH_VOCAB, draftStatus, ownerName } from '../model/branchVocab'
import { DraftStatusPill, OwnerAvatar } from './BranchStatusBits'
import { PullLatestButton } from './PullLatestButton'
import { BranchSettingsModal } from './BranchSettingsModal'
import { CommitDialog } from './CommitDialog'

type SortKey = 'recent' | 'name'

export function BranchManager({
  wsId,
  graphId,
  viewId,
  mainHead,
  currentBranchId,
  canManage,
  switchToDraft,
  onClose,
}: {
  wsId: string
  graphId: string
  viewId: string | null
  mainHead: number
  currentBranchId: string | null
  canManage: boolean
  switchToDraft: (branchId: string, originatingViewId?: string | null) => void
  onClose: () => void
}) {
  const { showToast } = useToast()
  const hasView = !!viewId
  // Branch-per-view: default to THIS view's own drafts. "Show all data-source drafts" is an
  // explicit, secondary toggle (default OFF) for the data-source-wide rollup — mirrors the
  // "this view / whole data source" pattern in ViewPrList/ViewHistoryTimeline.
  const [allDataSource, setAllDataSource] = useState(false)
  const branchesQ = useBranches(wsId, graphId, hasView && !allDataSource ? viewId : undefined)
  const openDraft = useOpenDraft(wsId, graphId)

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [settingsBranch, setSettingsBranch] = useState<Branch | null>(null)
  const [publishBranch, setPublishBranch] = useState<Branch | null>(null)
  const [archiveBranch, setArchiveBranch] = useState<Branch | null>(null)

  const drafts = useMemo(() => {
    const all = (branchesQ.data ?? []).filter((b) => b.kind !== 'main' && b.status === 'open')
    const q = query.trim().toLowerCase()
    const filtered = q
      ? all.filter((b) =>
          [b.name, b.description, ownerName(b.owner, b.userNames)].some((v) => (v ?? '').toLowerCase().includes(q)),
        )
      : all
    return [...filtered].sort((a, b) =>
      sort === 'name'
        ? (a.name || BRANCH_VOCAB.untitled).localeCompare(b.name || BRANCH_VOCAB.untitled)
        : (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    )
  }, [branchesQ.data, query, sort])

  const totalOpen = (branchesQ.data ?? []).filter((b) => b.kind !== 'main' && b.status === 'open').length

  const handleCreate = () => {
    openDraft.mutate(
      { name: newName.trim() || undefined, originatingViewId: viewId ?? undefined },
      {
        onSuccess: (r) => {
          switchToDraft(r.branchId, viewId)
          showToast('success', `Draft "${newName.trim() || 'Untitled'}" created — your edits stay private until you publish.`)
          setNewName('')
          setCreating(false)
          onClose()
        },
        onError: (e) => showToast('error', (e as Error).message),
      },
    )
  }

  return createPortal(
    <>
      <AnimatePresence>
      <motion.div
        key="branch-manager"
        className="fixed inset-0 z-[70] flex justify-end bg-black/40 backdrop-blur-[2px]"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.aside
          className="relative h-full w-full max-w-md bg-canvas border-l border-glass-border shadow-2xl flex flex-col"
          initial={{ x: 32, opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 32, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 border-b border-glass-border/60">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 border border-indigo-500/20 shrink-0">
                <GitBranch className="w-4.5 h-4.5 text-indigo-500 dark:text-indigo-400" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-ink tracking-tight">{BRANCH_VOCAB.manageAll}</h2>
                <p className="text-[11px] text-ink-muted">
                  {totalOpen === 0 ? 'No drafts yet' : `${totalOpen} ${totalOpen === 1 ? BRANCH_VOCAB.draft.toLowerCase() : BRANCH_VOCAB.draftPlural.toLowerCase()} · everything stays private until published`}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Toolbar */}
          <div className="px-5 py-3 flex items-center gap-2 border-b border-glass-border/40">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/70" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search drafts…"
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border text-[13px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:border-accent-lineage/50"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="shrink-0 px-2 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border text-[12px] text-ink-muted focus:outline-none focus:border-accent-lineage/50 cursor-pointer"
              title="Sort drafts"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </div>

          {hasView && (
            <div className="px-5 py-2 border-b border-glass-border/40">
              <div className="inline-flex rounded-lg border border-glass-border overflow-hidden text-[11px]">
                <button
                  onClick={() => setAllDataSource(false)}
                  className={cn(
                    'px-2.5 py-1 font-medium inline-flex items-center gap-1',
                    !allDataSource ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
                  )}
                >
                  <Eye className="w-3 h-3" /> This view
                </button>
                <button
                  onClick={() => setAllDataSource(true)}
                  title="Show every draft on this data source, across all views"
                  className={cn(
                    'px-2.5 py-1 font-medium border-l border-glass-border inline-flex items-center gap-1',
                    allDataSource ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
                  )}
                >
                  <Layers className="w-3 h-3" /> All data source drafts
                </button>
              </div>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3 space-y-2">
            {branchesQ.isLoading ? (
              <SkeletonRows />
            ) : drafts.length === 0 ? (
              <EmptyState hasAny={totalOpen > 0} canManage={canManage} onCreate={() => setCreating(true)} />
            ) : (
              drafts.map((b) => (
                <DraftCard
                  key={b.branchId}
                  branch={b}
                  wsId={wsId}
                  graphId={graphId}
                  mainHead={mainHead}
                  isCurrent={b.branchId === currentBranchId}
                  canManage={canManage}
                  onOpen={() => { switchToDraft(b.branchId, b.originatingViewId ?? null); onClose() }}
                  onSettings={() => setSettingsBranch(b)}
                  onPublish={() => setPublishBranch(b)}
                  onArchive={() => setArchiveBranch(b)}
                />
              ))
            )}
          </div>

          {/* Footer: create */}
          {canManage && (
            <div className="border-t border-glass-border/60 p-3">
              {creating ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate()
                      if (e.key === 'Escape') { setCreating(false); setNewName('') }
                    }}
                    placeholder="Name your draft (optional)"
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-canvas-elevated border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:border-accent-lineage/50"
                  />
                  <button
                    onClick={handleCreate}
                    disabled={openDraft.isPending}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-50"
                  >
                    {openDraft.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 transition-all hover:scale-[1.01] active:scale-[0.99]"
                >
                  <Plus className="w-4 h-4" /> {BRANCH_VOCAB.newDraft}
                </button>
              )}
            </div>
          )}
        </motion.aside>
      </motion.div>
      </AnimatePresence>

      {/* Per-draft sub-flows — each owns its own portal/animation, kept outside the drawer's presence. */}
      {settingsBranch && (
        <BranchSettingsModal
          wsId={wsId} graphId={graphId} viewId={viewId}
          branch={settingsBranch}
          onClose={() => setSettingsBranch(null)}
        />
      )}
      {publishBranch && (
        <PublishDraftDialog
          wsId={wsId} graphId={graphId} branch={publishBranch}
          onClose={() => setPublishBranch(null)}
        />
      )}
      {archiveBranch && (
        <ArchiveConfirm
          wsId={wsId} graphId={graphId} branch={archiveBranch}
          isCurrent={archiveBranch.branchId === currentBranchId}
          onClose={() => setArchiveBranch(null)}
        />
      )}
    </>,
    document.body,
  )
}

function DraftCard({
  branch, wsId, graphId, mainHead, isCurrent, canManage,
  onOpen, onSettings, onPublish, onArchive,
}: {
  branch: Branch
  wsId: string
  graphId: string
  mainHead: number
  isCurrent: boolean
  canManage: boolean
  onOpen: () => void
  onSettings: () => void
  onPublish: () => void
  onArchive: () => void
}) {
  const status = draftStatus(branch.baseCommitSeq, mainHead)
  return (
    <div
      className={cn(
        'group rounded-xl border bg-canvas-elevated/60 p-3 transition-colors',
        isCurrent ? 'border-accent-lineage/50 ring-1 ring-accent-lineage/25 bg-accent-lineage/[0.04]'
          : 'border-glass-border hover:border-glass-border/80 hover:bg-canvas-elevated',
      )}
    >
      <div className="flex items-start gap-3">
        <OwnerAvatar owner={branch.owner} userNames={branch.userNames} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink truncate">{branch.name || BRANCH_VOCAB.untitled}</h3>
            {isCurrent && (
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-accent-lineage bg-accent-lineage/10 px-1.5 py-0.5 rounded">Open now</span>
            )}
          </div>
          {branch.description ? (
            <p className="text-[12px] text-ink-muted line-clamp-2 mt-0.5">{branch.description}</p>
          ) : (
            <p className="text-[12px] text-ink-muted/60 italic mt-0.5">No description</p>
          )}
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-2">
            <DraftStatusPill status={status} />
            <span className="text-[11px] text-ink-muted">{ownerName(branch.owner, branch.userNames)}</span>
            <span className="text-ink-muted/40">·</span>
            <span className="text-[11px] text-ink-muted">edited {timeAgo(branch.updatedAt)}</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 mt-2.5 pt-2.5 border-t border-glass-border/40">
        <button
          onClick={onOpen}
          disabled={isCurrent}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-colors',
            isCurrent ? 'text-ink-muted/60 cursor-default'
              : 'text-accent-lineage hover:bg-accent-lineage/10',
          )}
        >
          {isCurrent ? <><Eye className="w-3.5 h-3.5" /> Viewing</> : <><ArrowRight className="w-3.5 h-3.5" /> Open</>}
        </button>

        <PullLatestButton
          variant="manager" wsId={wsId} graphId={graphId}
          branchId={branch.branchId} behind={status.behind}
        />

        <div className="flex-1" />

        {canManage && (
          <button
            onClick={onPublish}
            title={`${BRANCH_VOCAB.publish} this draft to the published version`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
          >
            <Rocket className="w-3.5 h-3.5" /> {BRANCH_VOCAB.publish}
          </button>
        )}
        <button
          onClick={onSettings}
          title="Settings — rename, describe, share link"
          className="p-1.5 rounded-lg text-ink-muted/80 hover:text-ink hover:bg-canvas-base transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
        {canManage && (
          <button
            onClick={onArchive}
            title={`${BRANCH_VOCAB.archive} this draft`}
            className="p-1.5 rounded-lg text-ink-muted/80 hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/** Publish a specific draft: fetches its diff lazily and reuses the standard CommitDialog. */
function PublishDraftDialog({
  wsId, graphId, branch, onClose,
}: {
  wsId: string
  graphId: string
  branch: Branch
  onClose: () => void
}) {
  const diffQ = useDiffVsMain(wsId, graphId, branch.branchId)
  const changeSet = useMemo(
    () => (diffQ.data ? fromDiffVsMain(diffQ.data, branch.branchId) : EMPTY_CHANGE_SET),
    [diffQ.data, branch.branchId],
  )
  if (diffQ.isLoading) {
    return createPortal(
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-canvas-elevated border border-glass-border text-sm text-ink-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> Preparing publish…
        </div>
      </div>,
      document.body,
    )
  }
  return (
    <CommitDialog
      workspaceId={wsId}
      graphId={graphId}
      branchId={branch.branchId}
      changeSet={changeSet}
      onClose={onClose}
    />
  )
}

function ArchiveConfirm({
  wsId, graphId, branch, isCurrent, onClose,
}: {
  wsId: string
  graphId: string
  branch: Branch
  isCurrent: boolean
  onClose: () => void
}) {
  const { showToast } = useToast()
  const abandon = useAbandonDraft(wsId, graphId)
  const run = () => {
    abandon.mutate(branch.branchId, {
      onSuccess: () => { showToast('success', `Draft "${branch.name || 'Untitled'}" archived.`); onClose() },
      onError: (e) => showToast('error', (e as Error).message),
    })
  }
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-sm rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
        initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 flex items-start gap-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-rose-500/10 shrink-0">
            <Archive className="w-4.5 h-4.5 text-rose-500" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">{BRANCH_VOCAB.archive} this draft?</h3>
            <p className="text-[12px] text-ink-muted mt-1">
              <span className="font-medium text-ink">{branch.name || 'Untitled draft'}</span> will be hidden and can no
              longer be edited or published. Its history is kept for the record.
              {isCurrent && ' You’ll be moved back to the Published version.'}
            </p>
          </div>
        </div>
        <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
            Cancel
          </button>
          <button
            onClick={run}
            disabled={abandon.isPending}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-rose-500 hover:bg-rose-600 shadow-sm disabled:opacity-50"
          >
            {abandon.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {BRANCH_VOCAB.archive} draft
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

function EmptyState({ hasAny, canManage, onCreate }: { hasAny: boolean; canManage: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12">
      <span className="flex items-center justify-center w-12 h-12 rounded-2xl bg-canvas-elevated border border-glass-border mb-3">
        <Inbox className="w-5 h-5 text-ink-muted/70" />
      </span>
      <p className="text-sm font-semibold text-ink">{hasAny ? 'No matching drafts' : 'No drafts yet'}</p>
      <p className="text-[12px] text-ink-muted mt-1 max-w-[16rem]">
        {hasAny
          ? 'Try a different search.'
          : 'Create a draft to edit safely. Your changes stay private until you publish.'}
      </p>
      {!hasAny && canManage && (
        <button
          onClick={onCreate}
          className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm"
        >
          <Plus className="w-4 h-4" /> {BRANCH_VOCAB.newDraft}
        </button>
      )}
    </div>
  )
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-3 animate-pulse">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-ink-muted/10" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 rounded bg-ink-muted/10" />
              <div className="h-2.5 w-3/4 rounded bg-ink-muted/10" />
              <div className="h-2.5 w-1/3 rounded bg-ink-muted/10" />
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
