/**
 * SaveRecipe — keep the change under review as a recipe in the view's library, to run again from
 * the Property Manager's Recipes: named here (and described, if wanted), inline. Offered to people
 * who can edit the view's library. A change aimed at entities picked by id — a selection, picked
 * relationships, a container — can't be kept, and the button says why.
 */
import { useState, type KeyboardEvent } from 'react'
import { BookmarkCheck, BookmarkPlus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useLibraryCanEdit, useViewLibraryStore } from '@/store/viewLibraryStore'
import { jobOp, propertyJobLabel, type OpDraft, type ScopeMode, type TargetPreset } from './opModel'
import { recipeTargetOf } from './recipes'
import { FIELD, LABEL, SECONDARY_EDGE } from './styles'

export function SaveRecipe({ op, preset, scopeMode }: { op: OpDraft; preset: TargetPreset; scopeMode: ScopeMode }) {
  const canEdit = useLibraryCanEdit()
  const saveRecipe = useViewLibraryStore((s) => s.saveRecipe)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  if (!canEdit) return null
  const kept = recipeTargetOf(preset, scopeMode)
  if ('reason' in kept) {
    return (
      <HoverTip label="Can’t keep this as a recipe" detail={kept.reason} className="inline-flex">
        <Button size="sm" variant="ghost" leftIcon={BookmarkPlus} disabled>Save as recipe</Button>
      </HoverTip>
    )
  }
  if (saved) {
    return (
      <p className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted" role="status">
        <BookmarkCheck className="h-3.5 w-3.5 text-accent-lineage" aria-hidden />
        Saved as “{saved}” — run it again from Recipes in Property Manager.
      </p>
    )
  }
  if (!naming) {
    return (
      <HoverTip label="Keep this change to run again" detail="Saved in the view’s library, for everyone who can open the view" className="inline-flex">
        <Button size="sm" variant="ghost" leftIcon={BookmarkPlus}
          onClick={() => { setName(propertyJobLabel(jobOp(op)).slice(0, 120)); setNaming(true) }}>
          Save as recipe
        </Button>
      </HoverTip>
    )
  }

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const recipe = await saveRecipe({ name: name.trim(), description: description.trim() || null, op: jobOp(op), target: kept.target })
      setSaved(recipe.name)
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
    <div className="space-y-2 rounded-lg border border-black/[0.07] dark:border-white/[0.08] p-2.5" onKeyDown={onKeyDown}>
      <div>
        <label className={LABEL} htmlFor="recipe-name">Recipe name</label>
        <input id="recipe-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={FIELD} />
      </div>
      <div>
        <label className={LABEL} htmlFor="recipe-description">Description <span className="normal-case tracking-normal font-normal">(optional)</span></label>
        <input id="recipe-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500}
          placeholder="e.g. Run after each import from the catalog" className={FIELD} />
      </div>
      {error && <p role="alert" className="text-[11.5px] text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        <Button size="sm" variant="secondary" className={SECONDARY_EDGE} leftIcon={BookmarkPlus} disabled={!name.trim()} loading={saving} onClick={() => void save()}>
          Save recipe
        </Button>
      </div>
    </div>
  )
}
