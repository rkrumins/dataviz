/**
 * EditDetailsPanel — the lightweight form for a view's METADATA (name,
 * description, tags, visibility). Saves via PUT /views/{id} — no wizard — and the
 * change is captured by the activity log's field diff. Structural edits (scope,
 * layers, layout) stay in the builder, which this panel links out to.
 *
 * Extracted from ExplorerPreviewDrawer, where it was a private function. That
 * made it unreachable from the full-canvas ViewPage, which is where people
 * actually spend their time and which therefore had NO way to rename a view or
 * change who can see it. One component, two hosts — the same reason the view-type
 * icon maps and the activity feed rows were pulled into shared modules after each
 * had silently drifted between surfaces.
 */
import { useState } from 'react'
import { Save, Settings2, Check, X, ChevronRight } from 'lucide-react'
import { updateView, updateViewVisibility, type View as ViewT } from '@/services/viewApiService'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { buildVisibilityOptions, type ViewVisibility } from '@/lib/viewVisibility'
import { cn } from '@/lib/utils'

/**
 * EditDetailsPanel — lightweight in-drawer form for a view's metadata
 * (name, description, tags, visibility). Saves via the existing PUT /views/{id}
 * — no wizard — and the change is captured by the activity log's field diff.
 * Structural edits (scope/layers/layout) stay in the builder ("Edit layout & scope").
 */
export function EditDetailsPanel({ view, onCancel, onSaved, onEditLayout, editDisabled }: {
  view: ViewT
  onCancel: () => void
  /** Receives the SAVED view. Hosts that mirror view state elsewhere (the canvas
   *  keeps its own copy) need the new values, not the stale ones they passed in.
   *  Zero-arg callbacks still work. */
  onSaved?: (updated: ViewT) => void
  onEditLayout?: () => void
  editDisabled?: boolean
}) {
  const { showToast } = useToast()
  const { appName } = useBrand()
  const canPublish = usePermission('workspace:view:publish', view.workspaceId)
  const [name, setName] = useState(view.name)
  const [description, setDescription] = useState(view.description ?? '')
  const [tagList, setTagList] = useState<string[]>(view.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>(view.visibility)
  const [saving, setSaving] = useState(false)

  const origTags = (view.tags ?? []).join('|')
  const dirty = name !== view.name
    || (description || '') !== (view.description || '')
    || tagList.join('|') !== origTags
    || visibility !== view.visibility

  const addTag = (raw: string) => {
    const t = raw.replace(/,+$/, '').trim()
    if (t && !tagList.includes(t)) setTagList(prev => [...prev, t])
    setTagInput('')
  }
  const removeTag = (t: string) => setTagList(prev => prev.filter(x => x !== t))

  const handleSave = async () => {
    if (!name.trim()) { showToast('error', 'Name is required'); return }
    setSaving(true)
    try {
      // The generic PUT rejects `visibility` (it carries its own
      // authorization — the publish gate), so the save is two steps.
      let updated = await updateView(view.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        tags: tagList,
      })
      if (visibility !== updated.visibility) {
        try {
          updated = await updateViewVisibility(view.id, visibility)
        } catch (visError) {
          showToast('error', `Details saved, but visibility could not be changed: ${(visError as Error).message}`)
          onSaved?.(updated)
          onCancel()
          return
        }
      }
      showToast('success', 'View details updated')
      onSaved?.(updated)
      onCancel()
    } catch {
      showToast('error', 'Couldn’t save changes')
    } finally {
      setSaving(false)
    }
  }

  const VIS = buildVisibilityOptions({
    saved: view.visibility,
    canPublish,
    appName,
    workspaceName: view.workspaceName,
  })

  const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-ink-muted mb-1.5'
  const inputCls = 'w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage/40 transition-shadow'

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-bold text-ink">Edit details</h3>
        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
          Update this view's name, description, tags and who can see it.
        </p>
      </div>

      <div>
        <label className={labelCls}>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="View name" autoFocus />
      </div>

      <div>
        <label className={labelCls}>Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className={cn(inputCls, 'resize-none')} placeholder="What does this view show? (optional)" />
      </div>

      <div>
        <label className={labelCls}>Tags</label>
        <div className={cn(inputCls, 'flex flex-wrap items-center gap-1.5 py-2 cursor-text')}>
          {tagList.map(t => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20 pl-2 pr-1 py-0.5 text-xs font-medium">
              {t}
              <button type="button" onClick={() => removeTag(t)} className="rounded-full hover:bg-accent-lineage/20 p-0.5" aria-label={`Remove ${t}`}>
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={e => { const v = e.target.value; if (v.endsWith(',')) addTag(v); else setTagInput(v) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput) }
              else if (e.key === 'Backspace' && !tagInput && tagList.length) removeTag(tagList[tagList.length - 1])
            }}
            onBlur={() => tagInput && addTag(tagInput)}
            placeholder={tagList.length ? 'Add…' : 'e.g. finance, quarterly'}
            className="flex-1 min-w-[90px] bg-transparent text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none"
          />
        </div>
        <p className="text-[10px] text-ink-muted mt-1">Press Enter or comma to add a tag.</p>
      </div>

      <div>
        <label className={labelCls}>Visibility</label>
        <div className="space-y-2">
          {VIS.map(({ id, icon: Icon, label, description: desc, disabled, disabledReason }) => {
            const active = visibility === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => { if (!disabled) setVisibility(id) }}
                disabled={disabled}
                title={disabledReason}
                className={cn(
                  'w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-accent-lineage/50 bg-accent-lineage/[0.06]'
                    : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02] hover:border-accent-lineage/30',
                  disabled && 'opacity-50 cursor-not-allowed hover:border-glass-border',
                )}
              >
                <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border', active ? 'bg-accent-lineage/10 border-accent-lineage/20 text-accent-lineage' : 'border-glass-border text-ink-muted')}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{label}</span>
                  <span className="block text-xs text-ink-muted">{disabled && disabledReason ? disabledReason : desc}</span>
                </span>
                <span className={cn('w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center', active ? 'border-accent-lineage bg-accent-lineage' : 'border-ink-muted/30')}>
                  {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {onEditLayout && (
        <div className="pt-2 border-t border-glass-border/60">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-muted mb-2 mt-2">Want to change the data or layout?</p>
          <button
            type="button"
            onClick={() => { if (!editDisabled) onEditLayout() }}
            disabled={editDisabled}
            title={editDisabled ? "Switch to this view's workspace to edit" : undefined}
            className={cn(
              'group/cta w-full flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left',
              'border-accent-lineage/45 bg-gradient-to-r from-accent-lineage/[0.10] to-violet-500/[0.06]',
              'shadow-sm shadow-accent-lineage/10 transition-all duration-200',
              editDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:from-accent-lineage/[0.16] hover:to-violet-500/[0.10] hover:border-accent-lineage/70 hover:-translate-y-0.5 hover:shadow-md',
            )}
          >
            <span className="w-9 h-9 rounded-lg bg-accent-lineage/15 text-accent-lineage border border-accent-lineage/25 flex items-center justify-center shrink-0">
              <Settings2 className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-accent-lineage">Edit layout &amp; scope</span>
              <span className="block text-xs text-ink-muted">Entity scope, layers, filters &amp; layout — in the builder</span>
            </span>
            <ChevronRight className="h-5 w-5 text-accent-lineage shrink-0 transition-transform group-hover/cta:translate-x-0.5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving || !dirty || !name.trim()}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold shadow-lg shadow-accent-lineage/25 hover:shadow-xl hover:-translate-y-0.5 disabled:opacity-50 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all duration-200"
        >
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2.5 rounded-xl border border-glass-border text-sm font-medium text-ink-muted hover:text-ink transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
