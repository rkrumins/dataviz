/**
 * StartEditingDialog — the deliberate "which branch?" step when entering Edit mode.
 *
 * Replaces the old silent behaviour where clicking Edit resumed whatever draft the server happened to
 * return (or auto-created an unnamed one). Now the user explicitly EITHER continues one of this view's
 * existing open drafts OR names a new branch. Reuses the versioning primitives: `useBranches` (list,
 * already view- + visibility-scoped by the backend), `useOpenDraft` (create, optional name),
 * `switchToDraft` (enter). Being on a draft IS edit mode, so entering + closing is all it takes.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useBranchStore } from '@/store/branchStore'
import { useBranches, useOpenDraft, VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import { BRANCH_VOCAB, ownerName } from '@/features/versioning/model/branchVocab'
import { OwnerAvatar } from '@/features/versioning/components/BranchStatusBits'

export interface StartEditingDialogProps {
  wsId: string
  graphId: string
  viewId: string | null
  onClose: () => void
}

export function StartEditingDialog({ wsId, graphId, viewId, onClose }: StartEditingDialogProps) {
  const branchesQ = useBranches(wsId, graphId, viewId)
  const openDraft = useOpenDraft(wsId, graphId)
  const switchToDraft = useBranchStore((s) => s.switchToDraft)
  const qc = useQueryClient()
  const [name, setName] = useState('')

  const drafts = (branchesQ.data ?? []).filter((b) => b.kind !== 'main' && b.status === 'open')

  const enter = (branchId: string, originatingViewId?: string | null) => {
    switchToDraft(branchId, originatingViewId ?? viewId)
    qc.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    onClose()
  }
  const createNew = () => {
    if (openDraft.isPending) return
    openDraft.mutate(
      { name: name.trim() || undefined, originatingViewId: viewId ?? undefined },
      { onSuccess: (r) => enter(r.branchId, viewId) },
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={openDraft.isPending ? undefined : onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="relative w-full max-w-xl rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/25 overflow-hidden"
      >
        <div className="flex items-start justify-between px-8 pt-7 pb-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-accent-lineage/[0.12] border border-accent-lineage/25 flex items-center justify-center">
              <LucideIcons.PenLine className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
            </div>
            <div>
              <h2 className="text-xl font-display font-semibold text-ink leading-tight">Start editing</h2>
              <p className="text-[13px] text-ink-muted mt-0.5">Edits go to a private draft — the published view stays untouched.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <LucideIcons.X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 pb-8 space-y-5">
          {/* Continue an existing draft */}
          {drafts.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">
                Continue a draft
              </p>
              <div className="space-y-1.5 max-h-64 overflow-y-auto -mx-1 px-1">
                {drafts.map((b) => (
                  <button
                    key={b.branchId}
                    onClick={() => enter(b.branchId, b.originatingViewId)}
                    className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left border border-glass-border/60 bg-black/[0.02] dark:bg-white/[0.02] hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.04] transition-colors group"
                  >
                    <OwnerAvatar owner={b.owner} userNames={b.userNames} size="sm" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14px] font-medium text-ink truncate">{b.name || BRANCH_VOCAB.untitled}</span>
                      <span className="block text-[12px] text-ink-muted truncate">
                        {ownerName(b.owner, b.userNames)}{b.updatedAt ? ` · edited ${timeAgo(b.updatedAt)}` : ''}
                      </span>
                    </span>
                    <LucideIcons.ArrowRight className="w-4 h-4 text-ink-muted/40 group-hover:text-accent-lineage group-hover:translate-x-0.5 transition-all shrink-0" />
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-glass-border" />
                <span className="text-[11px] text-ink-muted/70">or</span>
                <div className="flex-1 h-px bg-glass-border" />
              </div>
            </div>
          )}

          {/* Start a new branch */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">
              Start a new branch
            </p>
            <div className="flex items-center gap-2.5">
              <input
                autoFocus={drafts.length === 0}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createNew()
                  if (e.key === 'Escape') onClose()
                }}
                placeholder="Branch name (optional)"
                className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl bg-canvas-overlay border border-glass-border text-[14px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage transition-colors"
              />
              <button
                onClick={createNew}
                disabled={openDraft.isPending}
                className={cn(
                  'shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[14px] font-medium transition-colors',
                  'bg-accent-lineage text-white hover:bg-accent-lineage/90 disabled:opacity-60 disabled:cursor-not-allowed',
                )}
              >
                {openDraft.isPending ? (
                  <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <LucideIcons.Plus className="w-4 h-4" strokeWidth={2.4} />
                )}
                <span>{openDraft.isPending ? 'Creating…' : 'Create & edit'}</span>
              </button>
            </div>
            {openDraft.isError && (
              <p className="mt-1.5 text-[11px] text-rose-500">Couldn’t create the branch — try again.</p>
            )}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}
