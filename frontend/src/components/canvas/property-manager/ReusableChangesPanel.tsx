/**
 * ReusableChangesPanel — the view's reusable changes: bulk changes kept to run again (Save for
 * reuse, on a change's Review step), each run, renamed or deleted here — and, when asked, the ones
 * kept on the workspace's other views, to run in this one.
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
import { listReusableChangesFromOtherViews, type OtherViewReusableChange, type ReusableChange } from '@/services/viewLibraryService'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import { propertyJobLabel } from './op/opModel'
import { reusableChangeRequest, reusableChangeTargetLabel } from './op/reusableChanges'
import { FIELD, SECONDARY_EDGE } from './op/styles'

const NONE: ReusableChange[] = []

export function ReusableChangesPanel({ viewId }: { viewId: string }) {
  // The library the canvas loaded, when it is this view's.
  const changes = useViewLibraryStore((s) => (s.viewId === viewId ? s.reusableChanges : NONE))
  const canEdit = useViewLibraryStore((s) => s.viewId === viewId && s.canEdit)
  const editing = useEntityEditing()
  const { notify } = useAppNotifications()

  const run = editing.offered ? (change: ReusableChange) => {
    const { request, missingLayer } = reusableChangeRequest(change, useReferenceModelStore.getState().layers)
    if (missingLayer) notify('info', `This view has no layer named “${missingLayer}” — choose where “${change.name}” should apply.`)
    usePropertyJobsStore.getState().requestOp(request)
  } : undefined

  if (changes.length === 0 && !run) return null
  return (
    <section aria-label="Reusable changes" className="rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated overflow-hidden">
      {changes.length > 0 && (
        <>
          <h4 className="px-3.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Reusable changes · {changes.length.toLocaleString()}
          </h4>
          <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
            {changes.map((change) => (
              <ReusableChangeRow key={change.id} change={change} canEdit={canEdit} blocked={editing.blocked}
                onRun={run && (() => run(change))} />
            ))}
          </ul>
        </>
      )}
      {run && (
        <Disclosure
          className={cn(changes.length > 0 && 'border-t border-black/[0.06] dark:border-white/[0.06]')}
          buttonClassName="px-3.5 py-2 text-[11px] font-medium text-ink-secondary hover:text-ink"
          summary={changes.length > 0 ? 'From other views' : 'Reusable changes from other views'}
        >
          <OtherViewReusableChanges viewId={viewId} onRun={run} blocked={editing.blocked} />
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

/** A reusable change as its row reads it: its name (or the field renaming it), its description, what
 *  it does and where on two lines at most — the whole data source said as a badge, so a clipped line
 *  never hides it — and all of it on hover. */
function ReusableChangeText({ change, small = false, renaming }: { change: ReusableChange; small?: boolean; renaming?: ReactNode }) {
  const lines = (
    <>
      {renaming || <span className={cn('block font-semibold text-ink truncate', small ? 'text-[12px]' : 'text-[12.5px]')}>{change.name}</span>}
      {change.description && <span className="block text-[11px] text-ink-muted truncate">{change.description}</span>}
      <span className={cn('block text-[11px] line-clamp-2 break-words', small ? 'text-ink-muted' : 'text-ink-secondary')}>
        {propertyJobLabel(change.op)} · on {reusableChangeTargetLabel(change.target, false)}
      </span>
      {change.target.scopeMode === 'data_source' && <Badge tone="warning" className="mt-0.5">Whole data source</Badge>}
    </>
  )
  if (renaming) return <div className="min-w-0 flex-1">{lines}</div>
  return (
    <HoverTip className="block min-w-0 flex-1" label={change.name}
      detail={<>{propertyJobLabel(change.op)} · on {reusableChangeTargetLabel(change.target)}{change.description && <><br />{change.description}</>}</>}>
      {lines}
    </HoverTip>
  )
}

function ReusableChangeRow({ change, canEdit, blocked, onRun }: {
  change: ReusableChange
  canEdit: boolean
  blocked: string | null
  onRun?: () => void
}) {
  const saveReusableChange = useViewLibraryStore((s) => s.saveReusableChange)
  const removeReusableChange = useViewLibraryStore((s) => s.removeReusableChange)
  const { notify } = useAppNotifications()
  // The new name while it is typed; null when not renaming.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Deleting removes it for everyone: it asks first.
  const [confirming, setConfirming] = useState(false)

  const rename = async () => {
    const name = (renaming ?? '').trim()
    if (!name || name === change.name) { setRenaming(null); return }
    setSaving(true)
    try {
      await saveReusableChange({ id: change.id, name, description: change.description ?? null, op: change.op, target: change.target })
      setRenaming(null)
    } catch (e) {
      notify('error', `Couldn’t rename “${change.name}” — ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }
  const remove = () => {
    setConfirming(false)
    removeReusableChange(change.id).catch((e: Error) => notify('error', `Couldn’t delete “${change.name}” — ${e.message}`))
  }

  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <BookMarked className="mt-0.5 h-4 w-4 shrink-0 text-accent-lineage" aria-hidden />
        <ReusableChangeText change={change} renaming={renaming !== null && (
          <input
            aria-label={`New name for “${change.name}”`}
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
            {onRun && <RunButton name={change.name} onRun={onRun} blocked={blocked} />}
            {canEdit && (
              <>
                <IconButton icon={Pencil} label="Rename" size="sm" onClick={() => { setConfirming(false); setRenaming(change.name) }} />
                <IconButton icon={Trash2} label="Delete" detail="For everyone who opens this view" size="sm" variant="danger"
                  onClick={() => setConfirming(true)} />
              </>
            )}
          </>
        )}
      </div>
      {confirming && (
        <div className="mt-1.5 pl-6 flex flex-wrap items-center gap-2" role="group" aria-label={`Delete “${change.name}”`}>
          <span className="text-[11px] text-ink-secondary">Delete it for everyone who opens this view?</span>
          <Button size="sm" variant="danger" onClick={remove}>Delete reusable change</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
        </div>
      )}
    </li>
  )
}

/** The reusable changes kept on the workspace's other views the caller may open — over this view's
 *  data source first, one group per view — read when the section is opened. */
function OtherViewReusableChanges({ viewId, onRun, blocked }: {
  viewId: string
  onRun: (change: ReusableChange) => void
  blocked: string | null
}) {
  const [found, setFound] = useState<{ items: OtherViewReusableChange[]; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    listReusableChangesFromOtherViews(viewId, controller.signal)
      .then((items) => setFound({ items }))
      .catch((e: Error) => { if (!controller.signal.aborted) setFound({ items: [], error: e.message }) })
    return () => controller.abort()
  }, [viewId, attempt])

  // In the order the server gave them, one group per view.
  const groups = useMemo(() => {
    const out: { viewId: string; viewName: string; sameSource: boolean; items: OtherViewReusableChange[] }[] = []
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
      <EmptyState compact icon={LayoutGrid} title="No reusable changes on other views yet"
        description="Bulk changes kept for reuse on this workspace’s other views show here, to run in this one." />
    )
  }
  return (
    <div className="pb-2">
      {groups.map((g) => (
        <section key={g.viewId} aria-label={`Reusable changes from ${g.viewName}`}>
          <div className="flex flex-wrap items-baseline gap-x-2 px-3.5 pt-1.5">
            <h5 className="min-w-0 max-w-full text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted truncate">{g.viewName}</h5>
            {!g.sameSource && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">Another data source — its keys and layers may differ here</span>
            )}
          </div>
          <ul>
            {g.items.map(({ change }) => (
              <li key={change.id} className="flex items-start gap-2.5 px-3.5 py-1.5">
                <ReusableChangeText change={change} small />
                <RunButton name={change.name} onRun={() => onRun(change)} blocked={blocked} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
