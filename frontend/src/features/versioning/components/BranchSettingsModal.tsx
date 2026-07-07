/**
 * BranchSettingsModal — manage a draft branch: rename, optional description, shared/private
 * visibility, and a one-click shareable deep-link (/views/{viewId}?branch={branchId}). Opened from
 * the BranchSwitcher (per-draft gear). Edits go through useUpdateBranch (owner/maintainer gated
 * server-side); the link is permission-gated on open by useBranchDeepLink.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, GitBranch, Link2, Check, Loader2, Lock, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import type { Branch } from '@/services/versioningApiService'
import { useUpdateBranch } from '../hooks/useVersioning'

export function BranchSettingsModal({
  wsId,
  graphId,
  viewId,
  branch,
  onClose,
}: {
  wsId: string
  graphId: string
  viewId: string | null
  branch: Branch
  onClose: () => void
}) {
  const { showToast } = useToast()
  const update = useUpdateBranch(wsId, graphId)
  const [name, setName] = useState(branch.name ?? '')
  const [description, setDescription] = useState(branch.description ?? '')
  const [isShared, setIsShared] = useState(!!branch.isShared)
  const [copied, setCopied] = useState(false)

  // Prefer the view the branch was created from so the link lands on its home context; fall back to
  // the view in hand. Both resolve to the same data source, so the branch is accessible either way.
  const linkViewId = branch.originatingViewId ?? viewId
  const link = linkViewId
    ? `${window.location.origin}/views/${linkViewId}?branch=${branch.branchId}`
    : null

  const dirty =
    name.trim() !== (branch.name ?? '') ||
    description.trim() !== (branch.description ?? '') ||
    isShared !== !!branch.isShared

  const copyLink = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      showToast('error', 'Could not copy the link.')
    }
  }

  const save = () => {
    update.mutate(
      { branchId: branch.branchId, name: name.trim(), description: description.trim(), isShared },
      {
        onSuccess: () => { showToast('success', 'Draft updated.'); onClose() },
        onError: (e) => showToast('error', (e as Error).message),
      },
    )
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="branch-settings"
        className="fixed inset-0 z-[75] flex items-center justify-center p-4 bg-black/50"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="w-full max-w-md rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
          initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-glass-border/60">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 shrink-0">
                <GitBranch className="w-4 h-4 text-amber-500" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">Draft settings</h3>
                <p className="text-[11px] text-ink-muted truncate">{branch.name || 'Untitled draft'}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Untitled draft"
                className="w-full px-3 py-2 rounded-lg bg-canvas-elevated border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:border-accent-lineage/50"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">
                Description <span className="font-normal normal-case text-ink-muted/60">· optional</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="What is this branch for?"
                className="w-full px-3 py-2 rounded-lg bg-canvas-elevated border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:border-accent-lineage/50 resize-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">Visibility</label>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { v: false, Icon: Lock, label: 'Private', sub: 'Only you' },
                  { v: true, Icon: Users, label: 'Shared', sub: 'Team can access' },
                ] as const).map(({ v, Icon, label, sub }) => (
                  <button
                    key={label}
                    onClick={() => setIsShared(v)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition-colors',
                      isShared === v ? 'border-accent-lineage/50 bg-accent-lineage/[0.07] ring-1 ring-accent-lineage/30'
                        : 'border-glass-border hover:border-glass-border/80',
                    )}
                  >
                    <span className={cn('flex items-center gap-1.5 text-[12px] font-semibold', isShared === v ? 'text-accent-lineage' : 'text-ink')}>
                      <Icon className="w-3.5 h-3.5" /> {label}
                    </span>
                    <span className="block text-[10px] text-ink-muted mt-0.5">{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {link && (
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">Shareable link</label>
                <div className="flex items-center gap-1.5">
                  <input
                    readOnly value={link} onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-canvas-elevated border border-glass-border text-[11px] font-mono text-ink-muted focus:outline-none"
                  />
                  <button
                    onClick={copyLink}
                    className={cn('shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors',
                      copied ? 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10' : 'border-glass-border text-ink-muted hover:text-ink hover:bg-canvas-overlay')}
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="text-[10px] text-ink-muted/70 mt-1">Opens this view on this branch — only for people with access.</p>
              </div>
            )}
          </div>

          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || update.isPending || !name.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-50"
            >
              {update.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save changes
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
