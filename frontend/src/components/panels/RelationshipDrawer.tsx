/**
 * RelationshipDrawer — the EntityDrawer for a relationship.
 *
 * Opens when a line is clicked on the canvas. A line that stands for one
 * relationship shows THAT relationship: what it is and means, the two entities
 * it joins (each a click away, on the same back/forward trail as the entity
 * drawer), when and by whom it was created and last changed, its properties,
 * and its full revision history. A line that stands for several shows the
 * connection and lists them.
 *
 * Raw lineage relationships — the ones a graph's owners author and keep — can
 * be edited (properties) and deleted, in a draft, staged like every other
 * canvas edit. Roll-ups, hierarchy links and non-lineage types are shown
 * read-only, and say why.
 *
 * Details come from the drawer's own read (`useRelationshipRecord`), never the
 * canvas copy: canvas edges carry no properties and, from a trace, not even the
 * relationship's real id.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertCircle, AlertTriangle, Check, CheckCircle, Code, Copy, Crosshair, Eye, FileText, History,
  Info, Link, Loader2, Pencil, PencilLine, Save, Sparkles, Trash2, Waypoints,
} from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeature } from '@/store/features'
import { useViewContainmentEdgeTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual } from '@/hooks/useEntityVisual'
import { useRelationshipRecord } from '@/hooks/useRelationshipRecord'
import { edgeKind } from '@/services/ontologyPreflightService'
import { useEntityHistory } from '@/features/versioning/hooks/useVersioning'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Section } from './DrawerSection'
import { PropertyEditor } from './PropertyEditor'
import { PanelErrorBoundary } from './PanelErrorBoundary'
import { ActionButton, ModeTab, TimeStat } from './EntityDrawer'
import { useDrawerHistoryScope } from './useDrawerHistoryScope'
import { ConnectionView } from './relationship/ConnectionView'
import { Bridge, ConfirmDiscard, DetailRow, DrawerHeaderRow, Notice } from './relationship/RelationshipParts'
import { useEndpoints, useOpenEndpoint } from './relationship/useEndpoints'
import { KIND_COPY, openInEdgeExplorer, relationshipCopy } from './relationship/relationshipModel'
import { summarizeProvenance, type HistoryVersion, type ProvenanceMark } from './relationship/edgeProvenance'

interface RelationshipDrawerProps {
  /** Graph writes are possible here: a draft is open and nothing locks the canvas. */
  canEdit?: boolean
  /** A surface that refuses writes for its whole life (a canvas trace). */
  writesLocked?: boolean
  /** Entities the surface draws that the canvas store does not hold (a trace's cards). */
  resolveNode?: (id: string) => LineageNode | null
  /** Reveal an entity on the canvas (expanding what hides it). */
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  /** Reveal several entities and fit the canvas around them. */
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  /** Stage the deletion of a canvas edge — the canvas's own delete. */
  onDeleteEdge?: (canvasEdgeId: string) => void
  /** Open a draft, so a relationship on the published graph can be changed. */
  onStartEditing?: () => void
}

type RelationshipTarget = Extract<DrawerEdgeTarget, { kind: 'relationship' }>
type ViewMode = 'view' | 'edit' | 'json'

/** Mount only while a relationship is open (`drawerEdge`): the drawer keeps
 *  showing its last target through the rail's exit animation. */
export function RelationshipDrawer(props: RelationshipDrawerProps) {
  const live = useCanvasStore((s) => s.drawerEdge)
  // Keep the last target while the rail animates the drawer out, so it exits
  // showing what it showed rather than blanking first.
  const [last, setLast] = useState(live)
  if (live && live !== last) setLast(live)
  const target = live ?? last

  const closeNodeDrawer = useCanvasStore((s) => s.closeNodeDrawer)
  const clearSelection = useCanvasStore((s) => s.clearSelection)

  // Unsaved-changes gate for every move made FROM this drawer (trail, an
  // endpoint, a member, close). A move to the other kind unmounts the drawer,
  // so it must be asked before the move, not after.
  const [dirty, setDirty] = useState(false)
  const [pendingMove, setPendingMove] = useState<(() => void) | null>(null)
  const guard = useCallback((move: () => void) => {
    if (dirty) setPendingMove(() => move)
    else move()
  }, [dirty])
  const discardAndMove = useCallback(() => {
    const move = pendingMove
    setPendingMove(null)
    setDirty(false)
    move?.()
  }, [pendingMove])
  const close = useCallback(() => guard(() => {
    closeNodeDrawer()
    clearSelection()
  }), [guard, closeNodeDrawer, clearSelection])

  if (!target) return null
  return (
    <motion.aside
      data-panel="relationship-drawer"
      aria-label="Relationship details"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 'clamp(420px, 32vw, 560px)', opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={MOTION.drawerSlide}
      className="relative h-full flex-shrink-0 overflow-hidden bg-canvas-elevated border-l border-glass-border shadow-lg shadow-black/20"
    >
      <div className="relative w-[clamp(420px,32vw,560px)] h-full flex flex-col overflow-hidden">
        {pendingMove && <ConfirmDiscard onKeep={() => setPendingMove(null)} onDiscard={discardAndMove} />}
        {target.kind === 'relationship' ? (
          <RelationshipPanel key={`r:${target.id}`} {...props} target={target} guard={guard} onClose={close} onDirtyChange={setDirty} />
        ) : (
          <ConnectionView
            key={`c:${target.id}`}
            target={target}
            guard={guard}
            onClose={close}
            resolveNode={props.resolveNode}
            onFocusNode={props.onFocusNode}
            onLocateMany={props.onLocateMany}
          />
        )}
      </div>
    </motion.aside>
  )
}

function RelationshipPanel({
  target,
  guard,
  onClose,
  onDirtyChange,
  canEdit = false,
  writesLocked = false,
  resolveNode,
  onFocusNode,
  onLocateMany,
  onDeleteEdge,
  onStartEditing,
}: RelationshipDrawerProps & {
  target: RelationshipTarget
  guard: (move: () => void) => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const relationshipTypes = useViewRelationshipTypes()
  const containmentTypes = useViewContainmentEdgeTypes()
  const versioningEnabled = useFeature('versioningEnabled')
  const editModeEnabled = useFeature('editModeEnabled')
  const scope = useDrawerHistoryScope()

  // ── The relationship itself: the drawer's own read, else what the canvas knows ──
  const { record, entityId, unsaved, isLoading: recordLoading, isError: recordError, refetch } = useRelationshipRecord(target)
  const edges = useCanvasStore((s) => s.edges)
  const canvasEdge = useMemo(() => edges.find((e) => e.id === target.id), [edges, target.id])
  const type = record?.edgeType ?? target.edgeType
  const kind = edgeKind(type, relationshipTypes, containmentTypes)
  const copy = relationshipCopy(type, relationshipTypes)
  const color = useEdgeVisual(type).strokeColor
  const confidence = record?.confidence ?? canvasEdge?.data?.confidence

  const ids = useMemo(() => [target.source, target.target], [target.source, target.target])
  const endpoints = useEndpoints(ids, resolveNode)
  const source = endpoints.get(target.source)!
  const dest = endpoints.get(target.target)!
  const opener = useOpenEndpoint(onFocusNode, resolveNode)

  // ── History: the same query the History section renders ──
  const historyOn = versioningEnabled && !!scope.wsId && !!scope.graphId
  const history = useEntityHistory(
    historyOn ? scope.wsId : undefined,
    historyOn ? scope.graphId : undefined,
    historyOn && !unsaved && entityId ? entityId : undefined,
  )
  const versions = useMemo(() => (history.data?.versions ?? []) as HistoryVersion[], [history.data])
  const provenance = useMemo(
    () => summarizeProvenance(versions, { mainBranchId: scope.mainBranchId, branchId: scope.branchId, userNames: history.data?.userNames }),
    [versions, scope.mainBranchId, scope.branchId, history.data?.userNames],
  )

  // ── Staged work on this relationship ──
  const pendingEdit = useStagedChangesStore((s) =>
    entityId ? s.changes.find((c) => c.type === 'edit_edge' && c.targetId === entityId) : undefined)
  const pendingDelete = useStagedChangesStore((s) =>
    s.changes.find((c) => c.type === 'delete_edge' && (c.targetId === target.id || c.targetId === entityId)))
  const storedProps = useMemo(() => (record?.properties ?? {}) as Record<string, unknown>, [record])
  const shownProps = useMemo(
    () => ((pendingEdit?.after as { properties?: Record<string, unknown> } | undefined)?.properties) ?? storedProps,
    [pendingEdit, storedProps],
  )

  // ── Can this relationship be changed here? ──
  const editable = kind === 'lineage' && !unsaved && !writesLocked && versioningEnabled && editModeEnabled
    && canEdit && !!record && versions.length > 0 && !pendingDelete
  const readOnlyNotice = ((): { tone: 'info' | 'warn'; text: string; action?: { label: string; onClick: () => void } } | null => {
    if (kind !== 'lineage') return { tone: 'info', text: KIND_COPY[kind].readOnly! }
    if (unsaved) {
      return {
        tone: 'warn',
        text: 'Not saved yet — save your changes to add properties and see its history.',
        action: { label: 'Review & Save', onClick: () => useStagedChangesStore.getState().openReviewPanel() },
      }
    }
    if (pendingDelete) {
      return {
        tone: 'warn',
        text: 'Deletion staged — it is removed when you save, or discard it in Review.',
        action: { label: 'Review', onClick: () => useStagedChangesStore.getState().openReviewPanel() },
      }
    }
    if (writesLocked) return { tone: 'info', text: 'Read-only while tracing.' }
    if (!versioningEnabled || !editModeEnabled) return null
    if (!canEdit) {
      return {
        tone: 'info',
        text: 'Published — open a draft to change this relationship.',
        ...(onStartEditing ? { action: { label: 'Open a draft', onClick: onStartEditing } } : {}),
      }
    }
    if (recordLoading || (historyOn && history.isLoading)) return null
    if (!record) return { tone: 'warn', text: 'This relationship could not be found in the graph, so it can’t be edited here.' }
    if (historyOn && versions.length === 0) return { tone: 'info', text: 'Not under version control yet, so it can’t be edited here.' }
    return null
  })()

  // ── View / edit state ──
  const [mode, setMode] = useState<ViewMode>('view')
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [justStaged, setJustStaged] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => { onDirtyChange(hasChanges) }, [hasChanges, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  // Entering Edit starts from what is shown — unless there are unsaved edits
  // from a moment ago, which a trip to View must not throw away.
  const startEdit = () => {
    if (!hasChanges) setDraft({ ...shownProps })
    setMode('edit')
  }

  // "Edit this relationship" from the Edge Explorer: honoured once the drawer
  // knows the relationship can be edited, ignored if it cannot.
  const wantEdit = useRef(false)
  useEffect(() => {
    if (useCanvasStore.getState().consumeDrawerEdgeEditRequest()) wantEdit.current = true
  }, [])
  useEffect(() => {
    if (wantEdit.current && editable) {
      wantEdit.current = false
      setDraft({ ...shownProps })
      setMode('edit')
    }
  }, [editable, shownProps])

  const cancelEdit = () => {
    setHasChanges(false)
    setMode('view')
  }

  const stage = () => {
    if (!record || !entityId) return
    useStagedChangesStore.getState().stageOrReplace(
      (c) => c.type === 'edit_edge' && c.targetId === entityId,
      {
        type: 'edit_edge',
        targetId: entityId,
        // What was read — the diff base for the save. A later re-stage keeps the first one.
        before: { properties: storedProps },
        after: { properties: draft },
        summary: `Edit relationship '${source.name}' → '${dest.name}'`,
      },
    )
    setHasChanges(false)
    setMode('view')
    setJustStaged(true)
    setTimeout(() => setJustStaged(false), 2500)
  }

  const copyId = async () => {
    await navigator.clipboard?.writeText(entityId ?? target.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canDelete = !!onDeleteEdge && kind === 'lineage' && !writesLocked && !!canvasEdge
    && canvasEdge.id === entityId && !pendingDelete
  const deleteRelationship = () => guard(() => {
    onDeleteEdge!(canvasEdge!.id)
    useCanvasStore.getState().closeNodeDrawer()
  })

  const json = useMemo(() => JSON.stringify({
    id: entityId ?? target.id,
    type,
    source: target.source,
    target: target.target,
    ...(confidence !== undefined ? { confidence } : {}),
    properties: shownProps,
  }, null, 2), [entityId, target, type, confidence, shownProps])

  return (
    <>
      {/* Header */}
      <div
        className="flex-shrink-0 p-5 border-b border-glass-border"
        style={{ background: `linear-gradient(135deg, ${color}10 0%, transparent 60%)` }}
      >
        <DrawerHeaderRow badge={copy.label} badgeColor={color} guard={guard} onClose={onClose} onFocusNode={onFocusNode} />
        <Bridge
          source={source}
          target={dest}
          label={copy.label}
          color={color}
          onOpen={(id) => guard(() => { void opener.open(id) })}
          pendingId={opener.pendingId}
          unreachableId={opener.unreachableId}
        />

        <div className="flex items-center gap-2 flex-wrap mt-4">
          {onLocateMany && (
            <ActionButton icon={Crosshair} label="Locate both ends" onClick={() => { void onLocateMany([target.source, target.target]) }} />
          )}
          <ActionButton icon={copied ? Check : Copy} label={copied ? 'Copied!' : 'Copy ID'} onClick={() => { void copyId() }} />
          <ActionButton
            icon={Waypoints}
            label="Edge Explorer"
            onClick={() => guard(() => openInEdgeExplorer(canvasEdge ? [canvasEdge.id] : []))}
          />
          {canDelete && (
            <button
              type="button"
              onClick={deleteRelationship}
              title="Delete relationship"
              className="h-9 px-3 rounded-xl flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 transition-colors duration-150"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden lg:inline">Delete</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 mt-4 p-1 rounded-xl bg-black/5 dark:bg-white/5">
          <ModeTab active={mode === 'view'} onClick={() => setMode('view')} icon={Eye} label="View" />
          {editable && (
            <ModeTab
              active={mode === 'edit'}
              onClick={startEdit}
              icon={Pencil}
              label="Edit"
              badge={hasChanges ? '•' : undefined}
            />
          )}
          <ModeTab active={mode === 'json'} onClick={() => setMode('json')} icon={Code} label="JSON" />
        </div>

        <AnimatePresence>
          {(hasChanges || justStaged || (pendingEdit && mode === 'view')) && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3">
              {hasChanges ? (
                <Notice tone="warn"><span className="inline-flex items-center gap-2"><AlertTriangle className="w-4 h-4" />You have unsaved changes</span></Notice>
              ) : justStaged ? (
                <Notice tone="ok"><span className="inline-flex items-center gap-2"><CheckCircle className="w-4 h-4" />Changes staged</span></Notice>
              ) : (
                <Notice tone="info" action={{ label: 'Review & Save', onClick: () => useStagedChangesStore.getState().openReviewPanel() }}>
                  Showing your staged property changes — not saved yet.
                </Notice>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {readOnlyNotice && (
          <div className="px-5 pt-4">
            <Notice tone={readOnlyNotice.tone} action={readOnlyNotice.action}>{readOnlyNotice.text}</Notice>
          </div>
        )}

        {mode === 'view' && (
          <div className="divide-y divide-glass-border">
            <Section title="Identifier" icon={Link}>
              <div className="flex items-center gap-2 p-3 rounded-xl bg-black/5 dark:bg-white/5">
                <code className="flex-1 text-xs font-mono text-ink-muted truncate" title={entityId ?? target.id}>{entityId ?? target.id}</code>
              </div>
            </Section>

            <Section title="Details" icon={Info}>
              <div className="space-y-1">
                <DetailRow label="Type">{copy.label}{copy.label.toUpperCase() !== type.toUpperCase() && <span className="ml-1.5 font-mono text-ink-muted">{type}</span>}</DetailRow>
                {copy.description && <DetailRow label="Meaning">{copy.description}</DetailRow>}
                <DetailRow label="Kind">{KIND_COPY[kind].label}</DetailRow>
                <DetailRow label="From" mono>{target.source}</DetailRow>
                <DetailRow label="To" mono>{target.target}</DetailRow>
                {confidence !== undefined && confidence !== null && (
                  <div className="py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-ink-muted">Confidence</span>
                      <span className="text-xs text-ink">{Math.round(confidence * 100)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.round(confidence * 100)}%`, backgroundColor: color }} />
                    </div>
                  </div>
                )}
              </div>
            </Section>

            {historyOn && !unsaved && (
              <Section title="Provenance" icon={Sparkles}>
                {history.isLoading ? (
                  <p className="text-xs text-ink-muted inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…</p>
                ) : versions.length === 0 ? (
                  <p className="text-xs text-ink-muted italic">No recorded history for this relationship.</p>
                ) : (
                  <div className="space-y-1">
                    <ProvenanceRow label="Created" mark={provenance.created} />
                    <ProvenanceRow label="Last changed" mark={provenance.updated} />
                    <p className="pt-1 text-[11px] text-ink-muted">Published changes name whoever published them.</p>
                  </div>
                )}
              </Section>
            )}

            <Section title="Properties" icon={FileText} flush={Object.keys(shownProps).length > 0}>
              {recordLoading && !pendingEdit ? (
                <p className="text-xs text-ink-muted inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…</p>
              ) : recordError ? (
                <Notice tone="warn" action={{ label: 'Retry', onClick: () => { void refetch() } }}>
                  <span className="inline-flex items-center gap-2"><AlertCircle className="w-4 h-4" />Couldn’t load this relationship’s properties.</span>
                </Notice>
              ) : Object.keys(shownProps).length > 0 ? (
                <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
                  <PropertyEditor value={shownProps} onChange={() => {}} readOnly searchable groupByPath bare />
                </PanelErrorBoundary>
              ) : (
                <p className="text-xs text-ink-muted italic">
                  No properties yet.{editable ? ' Switch to Edit to add metadata.' : ''}
                </p>
              )}
            </Section>

            {historyOn && !unsaved && entityId && (
              <Section title="History" icon={History}>
                <EntityHistory
                  wsId={scope.wsId!}
                  graphId={scope.graphId!}
                  entityId={entityId}
                  mainBranchId={scope.mainBranchId}
                  branchId={scope.branchId}
                />
              </Section>
            )}
          </div>
        )}

        {mode === 'edit' && (
          <Section title="Properties" icon={FileText} flush>
            <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
              <PropertyEditor
                value={draft}
                onChange={(next) => {
                  setDraft(next as Record<string, unknown>)
                  setHasChanges(true)
                }}
                searchable
                groupByPath
                bare
              />
            </PanelErrorBoundary>
          </Section>
        )}

        {mode === 'json' && (
          <div className="p-5">
            <pre className="p-3 rounded-xl bg-black/5 dark:bg-white/5 text-xs font-mono text-ink whitespace-pre-wrap break-all">{json}</pre>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-4 border-t border-glass-border bg-canvas-elevated">
        {mode === 'edit' ? (
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={cancelEdit}
              className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/5 rounded-xl transition-colors duration-150"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={stage}
              disabled={!hasChanges}
              className={cn(
                'px-5 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors duration-150',
                hasChanges
                  ? 'bg-accent-lineage text-white hover:brightness-110 shadow-lg shadow-accent-lineage/25'
                  : 'bg-white/5 text-ink-muted cursor-not-allowed',
              )}
            >
              <Save className="w-4 h-4" />
              Stage Changes
            </button>
          </div>
        ) : historyOn && !unsaved ? (
          <div className="grid grid-cols-2 gap-2">
            <TimeStat
              icon={<Sparkles className="w-4 h-4" />}
              label={provenance.created?.inDraft ? 'Created · draft' : 'Created'}
              iso={provenance.created?.at}
              tone="emerald"
              loading={history.isLoading}
              emptyText="—"
            />
            <TimeStat
              icon={<PencilLine className="w-4 h-4" />}
              label={provenance.updated?.inDraft ? 'Updated · draft' : 'Updated'}
              iso={provenance.updated?.at}
              tone="indigo"
              loading={history.isLoading}
              emptyText="No changes yet"
            />
          </div>
        ) : (
          <p className="text-[11px] text-ink-muted text-center">
            {unsaved ? 'Save your changes to start this relationship’s history.' : 'History is available with version control.'}
          </p>
        )}
      </div>
    </>
  )
}

function ProvenanceRow({ label, mark }: { label: string; mark?: ProvenanceMark }) {
  return (
    <DetailRow label={label}>
      {mark ? (
        <span title={mark.at ? formatUtc(mark.at) : undefined}>
          {mark.at ? timeAgo(mark.at) : '—'} · by <span className="font-medium">{mark.by}</span>
          {mark.inDraft && <span className="ml-1.5 px-1.5 py-px rounded text-[10px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400">in this draft</span>}
        </span>
      ) : '—'}
    </DetailRow>
  )
}
