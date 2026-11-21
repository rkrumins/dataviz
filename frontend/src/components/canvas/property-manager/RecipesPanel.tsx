/**
 * RecipesPanel — the view's bulk recipes: changes kept to run again (Save as recipe, on a change's
 * Review step), each run, renamed or deleted here — and, when asked, the recipes kept on the
 * workspace's other views, to run in this one.
 *
 * Running one opens the bulk dialog with the whole change. The dialog counts and checks it again
 * in this view before anything is applied: a layer is found by its name (and, when this view has
 * none by that name, the dialog asks where), and a key no entity here holds is said on its What
 * step. Renaming and deleting are for people who can edit the view's library; running is offered
 * where a change can be made, as the Properties tab's other change actions are.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookMarked, Check, LayoutGrid, Pencil, Play, RefreshCw, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { Disclosure } from '@/components/ui/Disclosure'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { useEntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import { listRecipesFromOtherViews, type BulkRecipe, type OtherViewRecipe } from '@/services/viewLibraryService'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import { propertyJobLabel } from './op/opModel'
import { recipeRequest, recipeTargetLabel } from './op/recipes'
import { FIELD, SECONDARY_EDGE } from './op/styles'

const NONE: BulkRecipe[] = []

export function RecipesPanel({ viewId }: { viewId: string }) {
  // The library the canvas loaded, when it is this view's.
  const recipes = useViewLibraryStore((s) => (s.viewId === viewId ? s.bulkRecipes : NONE))
  const canEdit = useViewLibraryStore((s) => s.viewId === viewId && s.canEdit)
  const editing = useEntityEditing()
  const { notify } = useAppNotifications()

  const run = editing.offered ? (recipe: BulkRecipe) => {
    const { request, missingLayer } = recipeRequest(recipe, useReferenceModelStore.getState().layers)
    if (missingLayer) notify('info', `This view has no layer named “${missingLayer}” — choose where “${recipe.name}” should apply.`)
    usePropertyJobsStore.getState().requestOp(request)
  } : undefined

  if (recipes.length === 0 && !run) return null
  return (
    <section aria-label="Recipes" className="rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated overflow-hidden">
      {recipes.length > 0 && (
        <>
          <h4 className="px-3.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Recipes · {recipes.length.toLocaleString()}
          </h4>
          <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
            {recipes.map((recipe) => (
              <RecipeRow key={recipe.id} recipe={recipe} canEdit={canEdit} blocked={editing.blocked}
                onRun={run && (() => run(recipe))} />
            ))}
          </ul>
        </>
      )}
      {run && (
        <Disclosure
          className={cn(recipes.length > 0 && 'border-t border-black/[0.06] dark:border-white/[0.06]')}
          buttonClassName="px-3.5 py-2 text-[11px] font-medium text-ink-secondary hover:text-ink"
          summary={recipes.length > 0 ? 'From other views' : 'Recipes from other views'}
        >
          <OtherViewRecipes viewId={viewId} onRun={run} blocked={editing.blocked} />
        </Disclosure>
      )}
    </section>
  )
}

function RunButton({ name, onRun, blocked }: { name: string; onRun: () => void; blocked: string | null }) {
  return (
    <HoverTip label="Open it in the bulk change dialog" detail={blocked ?? 'Counted and checked again in this view before anything changes'}
      className="inline-flex shrink-0">
      <Button size="sm" variant="secondary" className={SECONDARY_EDGE} leftIcon={Play} disabled={!!blocked} onClick={onRun} aria-label={`Run “${name}”`}>Run</Button>
    </HoverTip>
  )
}

/** A recipe as its row reads it: its name (or the field renaming it), its description, what it does
 *  and where on two lines at most — the whole data source said as a badge, so a clipped line never
 *  hides it — and all of it on hover. */
function RecipeText({ recipe, small = false, renaming }: { recipe: BulkRecipe; small?: boolean; renaming?: ReactNode }) {
  const lines = (
    <>
      {renaming || <span className={cn('block font-semibold text-ink truncate', small ? 'text-[12px]' : 'text-[12.5px]')}>{recipe.name}</span>}
      {recipe.description && <span className="block text-[11px] text-ink-muted truncate">{recipe.description}</span>}
      <span className={cn('block text-[11px] line-clamp-2 break-words', small ? 'text-ink-muted' : 'text-ink-secondary')}>
        {propertyJobLabel(recipe.op)} · on {recipeTargetLabel(recipe.target, false)}
      </span>
      {recipe.target.scopeMode === 'data_source' && <Badge tone="warning" className="mt-0.5">Whole data source</Badge>}
    </>
  )
  if (renaming) return <div className="min-w-0 flex-1">{lines}</div>
  return (
    <HoverTip className="block min-w-0 flex-1" label={recipe.name}
      detail={<>{propertyJobLabel(recipe.op)} · on {recipeTargetLabel(recipe.target)}{recipe.description && <><br />{recipe.description}</>}</>}>
      {lines}
    </HoverTip>
  )
}

function RecipeRow({ recipe, canEdit, blocked, onRun }: {
  recipe: BulkRecipe
  canEdit: boolean
  blocked: string | null
  onRun?: () => void
}) {
  const saveRecipe = useViewLibraryStore((s) => s.saveRecipe)
  const removeRecipe = useViewLibraryStore((s) => s.removeRecipe)
  const { notify } = useAppNotifications()
  // The new name while it is typed; null when not renaming.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Deleting removes it for everyone: it asks first.
  const [confirming, setConfirming] = useState(false)

  const rename = async () => {
    const name = (renaming ?? '').trim()
    if (!name || name === recipe.name) { setRenaming(null); return }
    setSaving(true)
    try {
      await saveRecipe({ id: recipe.id, name, description: recipe.description ?? null, op: recipe.op, target: recipe.target })
      setRenaming(null)
    } catch (e) {
      notify('error', `Couldn’t rename “${recipe.name}” — ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }
  const remove = () => {
    setConfirming(false)
    removeRecipe(recipe.id).catch((e: Error) => notify('error', `Couldn’t delete “${recipe.name}” — ${e.message}`))
  }

  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <BookMarked className="mt-0.5 h-4 w-4 shrink-0 text-accent-lineage" aria-hidden />
        <RecipeText recipe={recipe} renaming={renaming !== null && (
          <input
            aria-label={`New name for “${recipe.name}”`}
            autoFocus
            value={renaming}
            maxLength={120}
            disabled={saving}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void rename() }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
            }}
            className={cn(FIELD, 'h-7')}
          />
        )} />
        {renaming !== null ? (
          <>
            <IconButton icon={Check} label="Save the name" size="sm" disabled={saving || !renaming.trim()} onClick={() => void rename()} />
            <IconButton icon={X} label="Keep the old name" size="sm" onClick={() => setRenaming(null)} />
          </>
        ) : (
          <>
            {onRun && <RunButton name={recipe.name} onRun={onRun} blocked={blocked} />}
            {canEdit && (
              <>
                <IconButton icon={Pencil} label="Rename" size="sm" onClick={() => { setConfirming(false); setRenaming(recipe.name) }} />
                <IconButton icon={Trash2} label="Delete" detail="For everyone who opens this view" size="sm" variant="danger"
                  onClick={() => setConfirming(true)} />
              </>
            )}
          </>
        )}
      </div>
      {confirming && (
        <div className="mt-1.5 pl-6 flex flex-wrap items-center gap-2" role="group" aria-label={`Delete “${recipe.name}”`}>
          <span className="text-[11px] text-ink-secondary">Delete it for everyone who opens this view?</span>
          <Button size="sm" variant="danger" onClick={remove}>Delete recipe</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
        </div>
      )}
    </li>
  )
}

/** The recipes kept on the workspace's other views the caller may open — over this view's data
 *  source first, one group per view — read when the section is opened. */
function OtherViewRecipes({ viewId, onRun, blocked }: {
  viewId: string
  onRun: (recipe: BulkRecipe) => void
  blocked: string | null
}) {
  const [found, setFound] = useState<{ items: OtherViewRecipe[]; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    listRecipesFromOtherViews(viewId, controller.signal)
      .then((items) => setFound({ items }))
      .catch((e: Error) => { if (!controller.signal.aborted) setFound({ items: [], error: e.message }) })
    return () => controller.abort()
  }, [viewId, attempt])

  // In the order the server gave them, one group per view.
  const groups = useMemo(() => {
    const out: { viewId: string; viewName: string; sameSource: boolean; items: OtherViewRecipe[] }[] = []
    for (const item of found?.items ?? []) {
      const last = out[out.length - 1]
      if (last?.viewId === item.viewId) last.items.push(item)
      else out.push({ viewId: item.viewId, viewName: item.viewName, sameSource: item.sameSource, items: [item] })
    }
    return out
  }, [found])

  if (!found) {
    return (
      <div className="px-3.5 pb-3 space-y-1.5" aria-busy="true" aria-label="Looking through the other views">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-4/5" />
      </div>
    )
  }
  if (found.error) {
    return (
      <EmptyState compact icon={LayoutGrid} title="Couldn’t look through the other views" description={found.error}
        action={{ label: 'Try again', icon: RefreshCw, onClick: () => { setFound(null); setAttempt((n) => n + 1) } }} />
    )
  }
  if (groups.length === 0) {
    return (
      <EmptyState compact icon={LayoutGrid} title="No recipes on other views yet"
        description="Bulk changes kept as recipes on this workspace’s other views show here, to run in this one." />
    )
  }
  return (
    <div className="pb-2">
      {groups.map((g) => (
        <section key={g.viewId} aria-label={`Recipes from ${g.viewName}`}>
          <div className="flex flex-wrap items-baseline gap-x-2 px-3.5 pt-1.5">
            <h5 className="min-w-0 max-w-full text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted truncate">{g.viewName}</h5>
            {!g.sameSource && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">Another data source — its keys and layers may differ here</span>
            )}
          </div>
          <ul>
            {g.items.map(({ recipe }) => (
              <li key={recipe.id} className="flex items-start gap-2.5 px-3.5 py-1.5">
                <RecipeText recipe={recipe} small />
                <RunButton name={recipe.name} onRun={() => onRun(recipe)} blocked={blocked} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
