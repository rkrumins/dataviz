/**
 * TombstoneDetails — a deleted entity or relationship: who deleted it, when and in which revision,
 * where it lived, what it held, what went with it and its history, and what can be done about it.
 *
 * One body, two hosts: the entity and relationship drawers show it for a tombstone on the canvas,
 * and `TombstoneDrawer` for a deleted row of any change list — a review's, the data source's
 * Versioning tab's — above whatever panel the list is in. Each read is asked only when it is shown:
 * the deletion when the details open, what went with it and the history only once unfolded.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, ChevronRight, Copy, GitCompare, History, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { queryClient } from '@/lib/queryClient'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { SkeletonText } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { getRevision, type ChangeListOrigin, type EntityDeletion } from '@/services/versioningApiService'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useFeature } from '@/store/features'
import { useStagedChangeCount } from '@/store/stagedChangesStore'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useDeletionCascade, useEntityDeletion, VERSIONING_KEYS } from '../hooks/useVersioning'
import { useRevisionViewer } from '../hooks/useRevisionViewer'
import { useRestoreDeletion } from '../canvas/useRestoreGhost'
import { actorName } from '../model/branchVocab'
import type { GraphChange } from '../model/changeModel'
import { CascadeImpactList } from './CascadeImpactList'
import { EntityDiff } from './EntityDiff'
import { EntityHistory } from './EntityHistory'
import { DeletedChip, STATUS_META } from './NodeDiffBadge'

/** A deletion to show: the entity, and the change list it was deleted in — a draft, or main between
 *  two revisions (its deletion is read as main had it at the newer one). */
export interface TombstoneTarget {
  wsId: string
  graphId: string
  entityId: string
  kind: 'node' | 'edge'
  origin: ChangeListOrigin
  /** Its name where the caller knows it, shown until what it held arrives. */
  label?: string
}

const nameIn = (v?: Record<string, unknown> | null): string | undefined => {
  const n = v?.displayName ?? v?.name ?? v?.label
  return typeof n === 'string' && n ? n : undefined
}
const short = (s: string) => (s.length > 32 ? `…${s.slice(-30)}` : s)

/** A part that unfolds, and only then asks for what it shows. */
function Fold({ title, children }: { title: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1 text-[12px] font-semibold text-ink-muted hover:text-ink transition-colors">
        <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        {title}
      </button>
      {open && <div className="pt-1">{children()}</div>}
    </div>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">{children}</p>
}

/** What went with it: the subtree it held and the relationships touching them, as they were. */
function WentWithIt({ target, rootUrn }: { target: TombstoneTarget; rootUrn: string }) {
  const q = useDeletionCascade(target.wsId, target.graphId, target.entityId, target.origin)
  if (q.isLoading) return <SkeletonText lines={2} className="py-1" />
  if (q.isError || !q.data) {
    return (
      <p className="text-[11px] text-ink-muted">
        Couldn’t load what went with it.{' '}
        <button type="button" onClick={() => { void q.refetch() }} className="font-semibold text-accent-lineage hover:underline">Retry</button>
      </p>
    )
  }
  const c = q.data
  if (c.reason === 'too_large') {
    return (
      <p className="text-[11px] text-ink-muted">
        {c.total
          ? `Too much went with it to list here: ${(c.total.nodes - 1).toLocaleString()} entities and ${c.total.links.toLocaleString()} relationships.`
          : 'Too many changes to list here.'}
      </p>
    )
  }
  const nodes = c.removed.filter((e) => e.kind === 'node')
  const links = c.removed.filter((e) => e.kind === 'edge')
  if (nodes.length <= 1 && links.length === 0) return <p className="text-[11px] text-ink-muted">Nothing else went with it.</p>
  return (
    <CascadeImpactList past rootUrn={rootUrn} impact={{
      nodeTotal: c.total?.nodes ?? nodes.length,
      edgeTotal: c.total?.links ?? links.length,
      nodes: nodes.map((e) => ({
        entityId: e.entityId, urn: e.urn ?? undefined,
        displayName: nameIn(e.before), entityType: (e.before?.entityType as string | undefined) ?? undefined,
      })),
      edges: links.map((e) => ({
        entityId: e.entityId, edgeType: (e.before?.edgeType as string | undefined) ?? undefined,
        sourceEntityId: e.sourceUrn ?? (e.before?.sourceEntityId as string | undefined),
        targetEntityId: e.targetUrn ?? (e.before?.targetEntityId as string | undefined),
      })),
    }} />
  )
}

/** Where it lived: a node's ancestors, root first; a relationship's two ends. */
function WhereItLived({ d, name }: { d: EntityDeletion; name: string }) {
  if (d.kind === 'edge') {
    const end = (e?: { urn: string; displayName?: string | null } | null) => (e ? e.displayName || short(e.urn) : '—')
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-ink min-w-0">
        <span className="truncate">{end(d.ends?.source)}</span>
        <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" aria-hidden />
        <span className="truncate">{end(d.ends?.target)}</span>
      </p>
    )
  }
  return (
    <ol aria-label="Where it lived" className="flex items-center flex-wrap gap-x-1 gap-y-0.5 text-[12px] text-ink-muted">
      {d.ancestors.length === 0 && <li className="italic">At the top, in nothing</li>}
      {d.ancestors.map((a) => (
        <li key={a.urn} className="flex items-center gap-1 min-w-0">
          <span className="truncate text-ink" title={a.urn}>{a.displayName || short(a.urn)}</span>
          <ChevronRight className="w-3 h-3 shrink-0" aria-hidden />
        </li>
      ))}
      {d.ancestors.length > 0 && <li className={cn('text-ink', STATUS_META.removed.strike)}>{name}</li>}
    </ol>
  )
}

export function TombstoneDetails({ target, onRestore, onNavigate }: {
  target: TombstoneTarget
  /** Brings it back into the draft; absent where it can't be. */
  onRestore?: () => void
  /** Called after the canvas is sent somewhere else (a revision opened, a comparison shown). */
  onNavigate?: () => void
}) {
  const { wsId, graphId, entityId, kind, origin } = target
  const branchId = 'branchId' in origin ? origin.branchId : null
  const atSeq = 'toSeq' in origin ? origin.toSeq : null
  const q = useEntityDeletion(wsId, graphId, entityId, { branchId, atSeq, kind })
  const d = q.data
  const del = d?.deleted ?? null
  const name = nameIn(d?.lastValue) ?? target.label ?? short(entityId)
  const urn = d?.urn ?? entityId
  const who = (id?: string | null) => actorName(id ?? undefined, d?.userNames)

  // What moves the canvas is offered on a canvas of this graph: elsewhere (a review, the data
  // source's page) there is no canvas to move.
  const view = useViewExecutionContext()
  const canvasGraphId = useBranchStore((s) => s.graphId)
  const onCanvas = !!view && canvasGraphId === graphId
  // A published deletion comes back through the person's draft: theirs to open, on a view they can
  // write, with editing and version control on.
  const canManage = usePermission('workspace:datasource:manage', wsId)
  const editMode = useFeature('editModeEnabled')
  const versioning = useFeature('versioningEnabled')
  const canRestoreIntoDraft = onCanvas && !view?.readOnly && canManage && editMode && versioning
  const restoreDeletion = useRestoreDeletion()
  const revisionViewer = useRevisionViewer(wsId)
  const unsaved = useStagedChangeCount()
  const openRevision = useBranchStore((s) => s.openRevision)
  const { notify } = useAppNotifications()
  const [copied, setCopied] = useState(false)

  const seeTheChange = () => {
    if (!del) return
    const panel = useVersioningPanelStore.getState()
    if (del.inDraft) panel.openPanel('changes')
    else panel.openCompare({ fromSeq: del.seq - 1, toSeq: del.seq })
    onNavigate?.()
  }
  // The graph just before it was deleted, with it shown. Too far back to draw, the comparison with
  // now still reaches it.
  const openBefore = async () => {
    if (!del || !d) return
    const seq = del.seq - 1
    try {
      const plan = await queryClient.fetchQuery({
        queryKey: VERSIONING_KEYS.revision(wsId, graphId, seq),
        queryFn: () => getRevision(wsId, graphId, seq),
        staleTime: 30_000,
      })
      if (!plan.openable) {
        useVersioningPanelStore.getState().openCompare({ fromSeq: seq, toSeq: null })
      } else {
        openRevision({
          seq,
          headAtOpen: plan.headSeq,
          commitId: (plan.commit.commit_id as string) ?? null,
          createdAt: (plan.commit.created_at as string) ?? null,
          message: (plan.commit.message as string) ?? null,
          actor: (plan.commit.actor as string) ?? null,
          reveal: kind === 'edge' ? d.ends?.source?.urn ?? null : urn,
        })
      }
      onNavigate?.()
    } catch {
      notify('error', 'That revision couldn’t be opened. Try again in a moment.')
    }
  }
  const copyUrn = () => {
    void navigator.clipboard?.writeText(urn)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const change: GraphChange = {
    entityId, kind, status: 'removed', label: name, before: d?.lastValue ?? undefined,
    origin: branchId ? { source: 'branch', branchId } : { source: 'compare', fromSeq: (origin as { fromSeq: number }).fromSeq, toSeq: atSeq! },
  }

  return (
    <div className="space-y-4">
      <section aria-label="How it was deleted" className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <DeletedChip />
          <span className="text-sm font-semibold text-rose-600 dark:text-rose-400">
            {del ? (del.inDraft ? 'Deleted in this draft' : `Deleted in #${del.seq}`) : 'Deleted'}
          </span>
        </div>
        {q.isLoading && <SkeletonText lines={1} className="mt-2" />}
        {q.isError && (
          <p className="mt-1.5 text-xs text-ink-muted">
            Couldn’t load who deleted it.{' '}
            <button type="button" onClick={() => { void q.refetch() }} className="font-semibold text-accent-lineage hover:underline">Retry</button>
          </p>
        )}
        {d && !del && <p className="mt-1.5 text-xs text-ink-muted">It isn’t deleted as of this revision.</p>}
        {del && (
          <p className="mt-1.5 text-xs text-ink-muted">
            by <span className="font-medium text-ink">{who(del.deletedBy)}</span>
            {' · '}
            <HoverTip label={formatUtc(del.at)} className="inline-flex"><span>{timeAgo(del.at)}</span></HoverTip>
            {(del.mergedBy || del.mergedAt) && (
              <>
                {' · published'}
                {del.mergedBy && <> by <span className="font-medium text-ink">{who(del.mergedBy)}</span></>}
                {del.mergedAt && <> <HoverTip label={formatUtc(del.mergedAt)} className="inline-flex"><span>{timeAgo(del.mergedAt)}</span></HoverTip></>}
              </>
            )}
          </p>
        )}
        {del?.message && <p className="mt-1.5 text-xs text-ink break-words">“{del.message}”</p>}
      </section>

      <div className="flex items-center gap-2 flex-wrap">
        {onRestore && (
          <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={onRestore}
            className="border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10">
            Restore
          </Button>
        )}
        {!onRestore && canRestoreIntoDraft && del && !del.inDraft && (
          <Button size="sm" variant="ghost" leftIcon={RotateCcw}
            onClick={() => { void restoreDeletion(target, name).then(() => onNavigate?.()) }}
            className="border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10">
            Restore into my draft
          </Button>
        )}
        {onCanvas && revisionViewer && del && !del.inDraft && (
          unsaved > 0 ? (
            <HoverTip label="Save or discard your unsaved edits first." className="inline-flex">
              <Button size="sm" variant="subtle" leftIcon={History} disabled>Open just before it was deleted</Button>
            </HoverTip>
          ) : (
            <Button size="sm" variant="subtle" leftIcon={History} onClick={() => { void openBefore() }}>
              Open just before it was deleted
            </Button>
          )
        )}
        {onCanvas && del && (del.inDraft || revisionViewer) && (
          <Button size="sm" variant="subtle" leftIcon={GitCompare} onClick={seeTheChange}>See the change</Button>
        )}
        <Button size="sm" variant="subtle" leftIcon={copied ? Check : Copy} onClick={copyUrn}>
          {copied ? 'Copied' : 'Copy URN'}
        </Button>
      </div>

      {d && (
        <div>
          <Heading>Where it lived</Heading>
          <WhereItLived d={d} name={name} />
        </div>
      )}

      {d?.lastValue && (
        <div>
          <Heading>What it held</Heading>
          <EntityDiff change={change} />
        </div>
      )}

      <div className="border-t border-glass-border pt-2 space-y-1">
        {kind === 'node' && (
          <Fold title="What went with it">{() => <WentWithIt target={target} rootUrn={urn} />}</Fold>
        )}
        <Fold title="History">
          {() => <EntityHistory wsId={wsId} graphId={graphId} entityId={entityId} branchId={branchId} kind={kind} deletionDetails={false} />}
        </Fold>
      </div>
    </div>
  )
}

/** The details of a deleted row of a change list, wherever the list is: above every panel. */
export function TombstoneDrawer({ target, onClose }: { target: TombstoneTarget; onClose: () => void }) {
  const titleId = useId()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[120]" className="bg-black/30 backdrop-blur-[2px]" />
      <div className="fixed inset-0 z-[121] flex justify-end p-3 pointer-events-none">
        <div role="dialog" aria-modal="true" aria-labelledby={titleId}
          className="pointer-events-auto w-full max-w-md h-full flex flex-col bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border overflow-hidden animate-fade-in">
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-glass-border bg-gradient-to-b from-rose-500/[0.06] to-transparent">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-600/80 dark:text-rose-400/80">
                {target.kind === 'edge' ? 'Deleted relationship' : 'Deleted entity'}
              </p>
              <h3 id={titleId} className={cn('mt-0.5 text-base font-semibold text-ink break-words', STATUS_META.removed.strike)}>
                {target.label ?? short(target.entityId)}
              </h3>
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="p-1.5 rounded-lg hover:bg-canvas-overlay transition-colors shrink-0">
              <X className="w-4 h-4 text-ink-muted" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            <TombstoneDetails target={target} onNavigate={onClose} />
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

/** "Deletion details" on a deleted row: opens its `TombstoneDrawer`. Nothing is asked until then. */
export function DeletionDetailsButton({ target, className }: { target: TombstoneTarget; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={cn('inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline', className)}>
        Deletion details <ArrowRight className="w-3 h-3" aria-hidden />
      </button>
      {open && <TombstoneDrawer target={target} onClose={() => setOpen(false)} />}
    </>
  )
}
