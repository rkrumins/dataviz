/**
 * SaveForReuse — keep the change under review in the view's library, to run again from the
 * Property Manager's Reusable changes: named here (and described, if wanted), inline. Offered to
 * people who can edit the view's library. A change aimed at entities picked by id — a selection,
 * picked relationships, a container — can't be kept, and the button says why.
 */
import { useState, type KeyboardEvent } from 'react'
import { BookmarkCheck, BookmarkPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useLibraryCanEdit, useViewLibraryStore } from '@/store/viewLibraryStore'
import { jobOp, propertyJobLabel, type OpDraft, type ScopeMode, type TargetPreset } from './opModel'
import { reusableChangeTargetOf } from './reusableChanges'
import { FIELD, LABEL, SECONDARY_EDGE } from './styles'

interface Props { op: OpDraft; preset: TargetPreset; scopeMode: ScopeMode }

/** Under its own label, so it lines up beside the reason. */
export function SaveForReuse({ className, ...props }: Props & { className?: string }) {
  if (!useLibraryCanEdit()) return null
  return (
    <div className={className}>
      <span className={LABEL}>Reusable change</span>
      <SaveForReuseBody {...props} />
    </div>
  )
}

function SaveForReuseBody({ op, preset, scopeMode }: Props) {
  const saveReusableChange = useViewLibraryStore((s) => s.saveReusableChange)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const kept = reusableChangeTargetOf(preset, scopeMode)
  if ('reason' in kept) {
    return (
      <HoverTip label="Can’t keep this for reuse" detail={kept.reason} className="inline-flex">
        <Button size="md" variant="secondary" className={cn(SECONDARY_EDGE, 'h-10')} leftIcon={BookmarkPlus} disabled>Save for reuse</Button>
      </HoverTip>
    )
  }
  if (saved) {
    return (
      <p className="flex items-start gap-1.5 text-[13px] text-ink-muted" role="status">
        <BookmarkCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
        <span>Kept for reuse as “{saved}” — run it again from Reusable changes in Property Manager.</span>
      </p>
    )
  }
  if (!naming) {
    return (
      <HoverTip label="Keep this change to run again" detail="Saved in the view’s library, for everyone who can open the view" className="inline-flex">
        <Button size="md" variant="secondary" className={cn(SECONDARY_EDGE, 'h-10')} leftIcon={BookmarkPlus}
          onClick={() => { setName(propertyJobLabel(jobOp(op)).slice(0, 120)); setNaming(true) }}>
          Save for reuse
        </Button>
      </HoverTip>
    )
  }

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const change = await saveReusableChange({ name: name.trim(), description: description.trim() || null, op: jobOp(op), target: kept.target })
      setSaved(change.name)
    } catch (e) {
      setError(`${((e as Error).message || 'It could not be saved').replace(/\.$/, '')} — change the name, or try again.`)
    } finally {
      setSaving(false)
    }
  }
  // Enter saves and Escape puts the form away — neither reaches the dialog, which would apply or close.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void save() }
    else if (e.key === 'Escape') { e.preventDefault(); setNaming(false) }
  }
  return (
    <div className="space-y-3 rounded-lg border border-black/[0.07] dark:border-white/[0.08] p-3" onKeyDown={onKeyDown}>
      <div>
        <label className={LABEL} htmlFor="reusable-change-name">Name</label>
        <input id="reusable-change-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={FIELD} />
      </div>
      <div>
        <label className={LABEL} htmlFor="reusable-change-description">Description <span className="normal-case tracking-normal font-normal">(optional)</span></label>
        <input id="reusable-change-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500}
          placeholder="e.g. Run after each import from the catalog" className={FIELD} />
      </div>
      {error && <p role="alert" className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        <Button size="sm" variant="secondary" className={SECONDARY_EDGE} leftIcon={BookmarkPlus} disabled={!name.trim()} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}
