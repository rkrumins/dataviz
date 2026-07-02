/**
 * EditViewDetailsDialog — edit a view's name, description, and tags from the
 * Context View header.
 *
 * The in-store ViewConfiguration only carries name + description, so on open
 * the dialog fetches the full view (GET /views/{id}) to seed tags too. Save
 * persists via viewApiService.updateView and hands the fields back through
 * onSaved so the canvas can refresh the schema store (header updates
 * instantly). A save failure keeps the dialog open with fields intact and
 * surfaces the server detail; a fetch failure toasts and closes.
 *
 * Visual conventions follow features/ontology/.../EditDetailsDialog (centred
 * modal, name input + description textarea) with ShareViewDialog's
 * framer-motion scale-in + z-[70] so the two view dialogs layer identically.
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, PenLine, Loader2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getView, updateView, type View } from '@/services/viewApiService'
import { useToast } from '@/components/ui/toast'

/** Provenance fields shown in the dialog's quiet footer. */
type ViewProvenance = Pick<View, 'createdByName' | 'createdAt' | 'updatedBy' | 'updatedByName' | 'updatedAt'>

function formatViewDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString()
}

export interface EditViewDetailsDialogProps {
  open: boolean
  viewId: string
  onClose: () => void
  onSaved: (updated: { name: string; description?: string; tags?: string[] }) => void
}

const FIELD_CLASS =
  'w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage/40 transition-colors duration-150'

export function EditViewDetailsDialog({ open, viewId, onClose, onSaved }: EditViewDetailsDialogProps) {
  const { showToast } = useToast()

  const [loading, setLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [provenance, setProvenance] = useState<ViewProvenance | null>(null)

  // Seed from a fresh fetch each time the dialog opens — the in-store view
  // lacks tags, and a re-open should reflect any changes made elsewhere.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    getView(viewId)
      .then(view => {
        if (cancelled) return
        setName(view.name ?? '')
        setDescription(view.description ?? '')
        setTags((view.tags ?? []).join(', '))
        setProvenance({
          createdByName: view.createdByName,
          createdAt: view.createdAt,
          updatedBy: view.updatedBy,
          updatedByName: view.updatedByName,
          updatedAt: view.updatedAt,
        })
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        showToast('error', err instanceof Error ? err.message : 'Failed to load view details')
        onClose()
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewId])

  const canSave = !!name.trim() && !loading && !isSaving

  const handleSave = async () => {
    if (!canSave) return
    const payload = {
      name: name.trim(),
      description,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    }
    setIsSaving(true)
    try {
      await updateView(viewId, payload)
      onSaved(payload)
      onClose()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save view details')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-lineage/20 to-purple-500/20 flex items-center justify-center shadow-md shadow-accent-lineage/10">
                  <PenLine className="w-5 h-5 text-accent-lineage" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-ink">Edit details</h3>
                  <p className="text-xs text-ink-muted">Name, description, and tags</p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            {loading ? (
              <div className="flex items-center justify-center py-16 text-ink-muted text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Loading details…
              </div>
            ) : (
              <div className="px-6 py-5 space-y-4">
                <div>
                  <label htmlFor="evd-name" className="block text-xs font-medium text-ink-secondary mb-1.5">
                    Name
                  </label>
                  <input
                    id="evd-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className={FIELD_CLASS}
                    placeholder="e.g., Data Lineage, Impact Analysis"
                  />
                </div>

                <div>
                  <label htmlFor="evd-description" className="block text-xs font-medium text-ink-secondary mb-1.5">
                    Description
                  </label>
                  <textarea
                    id="evd-description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={3}
                    className={cn(FIELD_CLASS, 'resize-none')}
                    placeholder="Describe what this view shows…"
                  />
                </div>

                <div>
                  <label htmlFor="evd-tags" className="block text-xs font-medium text-ink-secondary mb-1.5">
                    Tags
                  </label>
                  <input
                    id="evd-tags"
                    type="text"
                    value={tags}
                    onChange={e => setTags(e.target.value)}
                    className={FIELD_CLASS}
                    placeholder="finance, core, lineage"
                  />
                  <p className="text-[11px] text-ink-muted mt-1.5">Separate tags with commas.</p>
                </div>

                {provenance && (
                  <div className="pt-3 border-t border-glass-border/60 text-[11px] text-ink-muted">
                    Created by {provenance.createdByName ?? 'Unknown'} · {formatViewDate(provenance.createdAt)}
                    {provenance.updatedBy && (
                      <> · Last edited by {provenance.updatedByName ?? 'Unknown'} · {formatViewDate(provenance.updatedAt)}</>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border bg-glass-base/20 shrink-0">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={!canSave}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-accent-lineage text-white text-sm font-semibold hover:brightness-110 transition-all disabled:opacity-50 shadow-sm shadow-accent-lineage/20"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
