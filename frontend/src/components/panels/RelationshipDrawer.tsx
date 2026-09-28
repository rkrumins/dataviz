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
 *
 * Built on the drawer frame and shell: while an edit is unstaged, every move of
 * the drawer asks first.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Check, Code, Copy, Crosshair, Eye, FileText, History, Info, Link, Pencil, PencilLine,
  Sparkles, Trash2, Waypoints,
} from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeature } from '@/store/features'
import { useViewContainmentEdgeTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual } from '@/hooks/useEntityVisual'
import { useRelationshipRecord } from '@/hooks/useRelationshipRecord'
import { edgeKind } from '@/services/ontologyPreflightService'
import { useEntitySummary } from '@/features/versioning/hooks/useVersioning'
import { actorName } from '@/features/versioning/model/branchVocab'
import type { EntityEvent } from '@/services/versioningApiService'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import { edgeIndexOf } from '@/lib/storeIndex'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { SkeletonText } from '@/components/ui/Skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Section } from './DrawerSection'
import { PropertyEditor } from './PropertyEditor'
import { PanelErrorBoundary } from './PanelErrorBoundary'
import { useDrawerHistoryScope } from './useDrawerHistoryScope'
import { DrawerBody, DrawerFooter, DrawerFrame, DrawerHeader, DrawerShell } from './shell/DrawerShell'
import { DrawerTopBar, KindBadge } from './shell/DrawerTopBar'
import { FreshnessStat } from './shell/FreshnessStat'
import { JsonView } from './shell/JsonView'
import { StageBar } from './shell/StageBar'
import { ConnectionView } from './relationship/ConnectionView'
import { Bridge, DetailRow, Notice } from './relationship/RelationshipParts'
import { useEndpoints, useOpenEndpoint } from './relationship/useEndpoints'
import { KIND_COPY, openInEdgeExplorer, relationshipCopy } from './relationship/relationshipModel'

/** Created / last changed, as the summary reports them for the line being read. */
interface ProvenanceMark {
  at?: string
  /** The actor's id, when it is a person. */
  userId: string | null
  by: string
  /** The draft's own change — not published yet. */
  inDraft: boolean
}

const markOf = (e: EntityEvent | null | undefined, names?: Record<string, string>): ProvenanceMark | undefined =>
  e ? {
    at: e.at,
    userId: e.actor && e.actor !== 'system' ? e.actor : null,
    by: actorName(e.actor ?? undefined, names),
    inDraft: e.inDraft,
  } : undefined

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

const closeDrawer = () => useCanvasStore.getState().requestDrawerMove(() => {
  const s = useCanvasStore.getState()
  s.closeNodeDrawer()
  s.clearSelection()
})

/** Mount only while a relationship is open (`drawerEdge`): the drawer keeps
 *  showing its last target through the rail's exit animation. Memoised: a
 *  canvas re-rendering never re-renders the drawer. */
export const RelationshipDrawer = memo(function RelationshipDrawer(props: RelationshipDrawerProps) {
  const live = useCanvasStore((s) => s.drawerEdge)
  // Keep the last target while the rail animates the drawer out, so it exits
  // showing what it showed rather than blanking first.
  const [last, setLast] = useState(live)
  if (live && live !== last) setLast(live)
  const target = live ?? last

  if (!target) return null
  return (
    <DrawerFrame panel="relationship-drawer" label="Relationship details">
      {target.kind === 'relationship' ? (
        <RelationshipPanel key={`r:${target.id}`} {...props} target={target} onClose={closeDrawer} />
      ) : (
        <ConnectionView
          key={`c:${target.id}`}
          target={target}
          onClose={closeDrawer}
          resolveNode={props.resolveNode}
          onFocusNode={props.onFocusNode}
          onLocateMany={props.onLocateMany}
        />
      )}
    </DrawerFrame>
  )
})

function RelationshipPanel({
  target,
  onClose,
  canEdit = false,
  writesLocked = false,
  resolveNode,
  onFocusNode,
  onLocateMany,
  onDeleteEdge,
  onStartEditing,
}: RelationshipDrawerProps & {
  target: RelationshipTarget
  onClose: () => void
}) {
  const relationshipTypes = useViewRelationshipTypes()
  const containmentTypes = useViewContainmentEdgeTypes()
  const versioningEnabled = useFeature('versioningEnabled')
  const editModeEnabled = useFeature('editModeEnabled')
  const scope = useDrawerHistoryScope()
  const titleId = useId()

  // ── The relationship itself: the drawer's own read, else what the canvas knows ──
  const { record, entityId, unsaved, isLoading: recordLoading, isError: recordError, refetch } = useRelationshipRecord(target)
  const canvasEdge = useCanvasStore((s) => edgeIndexOf(s.edges).get(target.id))
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

  // ── Provenance: who created and last changed it, as this line (main, or the open draft) has it ──
  const historyOn = versioningEnabled && !!scope.wsId && !!scope.graphId
  const draftId = scope.branchId && scope.branchId !== scope.mainBranchId ? scope.branchId : null
  const summaryQ = useEntitySummary(
    historyOn ? scope.wsId : undefined,
    historyOn ? scope.graphId : undefined,
    historyOn && !unsaved && entityId ? entityId : undefined,
    { branchId: draftId, kind: 'edge', includeValue: true },
  )
  const summary = summaryQ.data
  const tracked = !!summary?.exists
  const provenance = useMemo(() => ({
    created: markOf(summary?.created, summary?.userNames),
    updated: markOf(summary?.updated, summary?.userNames),
  }), [summary])
  // The value this line holds, with its token — the baseline an edit is a patch against.
  const stored = summary?.value?.kind === 'edge' && !summary.value.deleted ? summary.value : undefined

  // ── Staged work on this relationship ──
  const pendingEdit = useStagedChangesStore((s) =>
    entityId ? s.changes.find((c) => c.type === 'edit_edge' && c.targetId === entityId) : undefined)
  const pendingDelete = useStagedChangesStore((s) =>
    s.changes.find((c) => c.type === 'delete_edge' && (c.targetId === target.id || c.targetId === entityId)))
  const storedProps = useMemo(
    () => (stored?.edge.properties ?? record?.properties ?? {}) as Record<string, unknown>, [stored, record])
  const baseVersion = stored?.version ?? record?.version
  const shownProps = useMemo(
    () => ((pendingEdit?.after as { properties?: Record<string, unknown> } | undefined)?.properties) ?? storedProps,
    [pendingEdit, storedProps],
  )

  // ── Can this relationship be changed here? ──
  const editable = kind === 'lineage' && !unsaved && !writesLocked && versioningEnabled && editModeEnabled
    && canEdit && !!record && tracked && !pendingDelete
  const openReview = () => useStagedChangesStore.getState().openReviewPanel()
  const readOnlyNotice = ((): { tone: 'info' | 'warn'; text: string; action?: { label: string; onClick: () => void } } | null => {
    if (kind !== 'lineage') return { tone: 'info', text: KIND_COPY[kind].readOnly! }
    if (unsaved) {
      return { tone: 'warn', text: 'Not saved yet — save your changes to add properties and see its history.', action: { label: 'Review & Save', onClick: openReview } }
    }
    if (pendingDelete) {
      return { tone: 'warn', text: 'Deletion staged — it is removed when you save, or discard it in Review.', action: { label: 'Review', onClick: openReview } }
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
    if (recordLoading || (historyOn && summaryQ.isLoading)) return null
    if (!record) return { tone: 'warn', text: 'This relationship could not be found in the graph, so it can’t be edited here.' }
    if (historyOn && !tracked) return { tone: 'info', text: 'Not under version control yet, so it can’t be edited here.' }
    return null
  })()

  // ── View / edit state ──
  const [mode, setMode] = useState<ViewMode>('view')
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [justStaged, setJustStaged] = useState(false)
  const [copied, setCopied] = useState(false)
  const shownMode: ViewMode = mode === 'edit' && !editable ? 'view' : mode

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

  const discard = () => {
    setHasChanges(false)
    setMode('view')
  }

  const stagedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(stagedTimer.current), [])
  const stage = () => {
    if (!record || !entityId || !hasChanges) return
    useStagedChangesStore.getState().stageOrReplace(
      (c) => c.type === 'edit_edge' && c.targetId === entityId,
      {
        type: 'edit_edge',
        targetId: entityId,
        // What was read, and its token — the diff base for the save and its concurrency check.
        // A later re-stage keeps the first one.
        before: { properties: storedProps, ...(baseVersion ? { version: baseVersion } : {}) },
        after: { properties: draft },
        summary: `Edit relationship '${source.name}' → '${dest.name}'`,
      },
    )
    setHasChanges(false)
    setMode('view')
    setJustStaged(true)
    clearTimeout(stagedTimer.current)
    stagedTimer.current = setTimeout(() => setJustStaged(false), 2500)
  }

  const copyId = async () => {
    await navigator.clipboard?.writeText(entityId ?? target.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canDelete = !!onDeleteEdge && kind === 'lineage' && !writesLocked && !!canvasEdge
    && canvasEdge.id === entityId && !pendingDelete
  const deleteRelationship = () => useCanvasStore.getState().requestDrawerMove(() => {
    onDeleteEdge!(canvasEdge!.id)
    useCanvasStore.getState().closeNodeDrawer()
  })

  const jsonData = useMemo(() => ({
    id: entityId ?? target.id,
    type,
    source: target.source,
    target: target.target,
    ...(confidence !== undefined ? { confidence } : {}),
    properties: shownProps,
  }), [entityId, target, type, confidence, shownProps])

  const hasProps = Object.keys(shownProps).length > 0
  const editing = shownMode === 'edit' || hasChanges || justStaged

  return (
    <DrawerShell
      titleId={titleId}
      focusKey={target.id}
      dirty={hasChanges}
      dirtyWhat="your changes to this relationship"
      onClose={onClose}
      onStage={stage}
      canStage={hasChanges}
      onDiscard={discard}
    >
      <Tabs
        value={shownMode}
        onValueChange={(v) => (v === 'edit' ? startEdit() : setMode(v as ViewMode))}
        className="flex flex-col flex-1 min-h-0"
      >
        <DrawerHeader style={{ background: `linear-gradient(135deg, ${color}10 0%, transparent 60%)` }}>
          <DrawerTopBar
            badge={<KindBadge label={copy.label} bg={`${color}1a`} fg={color} />}
            closeLabel="Close relationship details"
            onClose={onClose}
            onFocusNode={onFocusNode}
          />
          <h2 id={titleId} tabIndex={-1} className="sr-only">
            {copy.label}: {source.name} to {dest.name}
          </h2>
          <Bridge
            source={source}
            target={dest}
            label={copy.label}
            color={color}
            onOpen={opener.open}
            pendingId={opener.pendingId}
            unreachableId={opener.unreachableId}
          />

          <div className="flex items-center gap-2 flex-wrap mt-4">
            {onLocateMany && (
              <Button size="sm" variant="subtle" leftIcon={Crosshair} onClick={() => { void onLocateMany([target.source, target.target]) }}>
                Locate both ends
              </Button>
            )}
            <Button size="sm" variant="subtle" leftIcon={copied ? Check : Copy} onClick={() => { void copyId() }}>
              {copied ? 'Copied' : 'Copy ID'}
            </Button>
            <Button
              size="sm"
              variant="subtle"
              leftIcon={Waypoints}
              onClick={() => useCanvasStore.getState().requestDrawerMove(() => openInEdgeExplorer(canvasEdge ? [canvasEdge.id] : []))}
            >
              Edge Explorer
            </Button>
            {canDelete && (
              <Button
                size="sm"
                variant="subtle"
                leftIcon={Trash2}
                onClick={deleteRelationship}
                title="Delete relationship"
                className="text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 dark:bg-rose-500/10 dark:hover:bg-rose-500/20"
              >
                Delete
              </Button>
            )}
          </div>

          <TabsList aria-label="Relationship details" className="mt-4">
            <TabsTrigger value="view" icon={Eye}>View</TabsTrigger>
            {editable && (
              <TabsTrigger value="edit" icon={Pencil}
                badge={hasChanges ? <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="unsaved changes" /> : undefined}>
                Edit
              </TabsTrigger>
            )}
            <TabsTrigger value="json" icon={Code}>JSON</TabsTrigger>
          </TabsList>
        </DrawerHeader>

        <DrawerBody>
          {(readOnlyNotice || (pendingEdit && shownMode === 'view')) && (
            <div className="px-5 pt-4 space-y-2">
              {readOnlyNotice && <Notice tone={readOnlyNotice.tone} action={readOnlyNotice.action}>{readOnlyNotice.text}</Notice>}
              {pendingEdit && shownMode === 'view' && (
                <Notice tone="info" action={{ label: 'Review & Save', onClick: openReview }}>
                  Showing your staged property changes — not saved yet.
                </Notice>
              )}
            </div>
          )}

          <TabsContent value="view">
            <div className="divide-y divide-glass-border">
              <Section title="Identifier" icon={Link}>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
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
                        <span className="text-xs text-ink tabular-nums">{Math.round(confidence * 100)}%</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"
                        role="meter" aria-label="Confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(confidence * 100)}>
                        <div className="h-full rounded-full" style={{ width: `${Math.round(confidence * 100)}%`, backgroundColor: color }} />
                      </div>
                    </div>
                  )}
                </div>
              </Section>

              {historyOn && !unsaved && (
                <Section title="Provenance" icon={Sparkles}>
                  {summaryQ.isLoading ? (
                    <SkeletonText lines={3} />
                  ) : !summary?.created ? (
                    <p className="text-xs text-ink-muted italic">No recorded history for this relationship.</p>
                  ) : (
                    <div className="space-y-1">
                      <ProvenanceRow label="Created" mark={provenance.created} />
                      <ProvenanceRow label="Last changed" mark={provenance.updated} />
                      <DetailRow label="Revisions">
                        {summary.revisions.published.toLocaleString()} published
                        {draftId && <> · {summary.revisions.draft.toLocaleString()} in this draft</>}
                      </DetailRow>
                      {summary.changedOnMainSinceBranch && (
                        <div className="pt-1">
                          <Notice tone="info">Changed on the published graph since this draft began — this draft still shows it as it was.</Notice>
                        </div>
                      )}
                      <p className="pt-1 text-[11px] text-ink-muted">Published changes name whoever published them.</p>
                    </div>
                  )}
                </Section>
              )}

              <Section title="Properties" icon={FileText} flush={hasProps}>
                {recordLoading && !pendingEdit ? (
                  <SkeletonText lines={3} />
                ) : recordError ? (
                  <Notice tone="warn" action={{ label: 'Retry', onClick: () => { void refetch() } }}>
                    <span className="inline-flex items-center gap-2"><AlertCircle className="w-4 h-4" aria-hidden />Couldn’t load this relationship’s properties.</span>
                  </Notice>
                ) : hasProps ? (
                  <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
                    <PropertyEditor value={shownProps} onChange={() => {}} readOnly searchable groupByPath bare />
                  </PanelErrorBoundary>
                ) : (
                  <EmptyState compact icon={FileText} title="No properties yet"
                    description={editable ? 'Record what this flow carries, how often, who owns it.' : undefined}
                    action={editable ? { label: 'Add properties', onClick: startEdit } : undefined} />
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
                    kind="edge"
                  />
                </Section>
              )}
            </div>
          </TabsContent>

          {editable && (
            <TabsContent value="edit">
              <Section title="Properties" icon={FileText} flush>
                <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
                  <PropertyEditor
                    value={draft}
                    onChange={(next) => {
                      setDraft(next as Record<string, unknown>)
                      setHasChanges(true)
                      setJustStaged(false)
                    }}
                    searchable
                    groupByPath
                    bare
                  />
                </PanelErrorBoundary>
              </Section>
            </TabsContent>
          )}

          <TabsContent value="json">
            <JsonView data={jsonData} label="Relationship data as JSON" />
          </TabsContent>
        </DrawerBody>

        <DrawerFooter>
          {editing ? (
            <StageBar dirty={hasChanges} justStaged={justStaged} onCancel={discard} onStage={stage} />
          ) : historyOn && !unsaved ? (
            <div className="grid grid-cols-2 gap-2">
              <FreshnessStat
                icon={<Sparkles className="w-4 h-4" />}
                label={provenance.created?.inDraft ? 'Created · draft' : 'Created'}
                iso={provenance.created?.at}
                tone="emerald"
                loading={summaryQ.isLoading}
                by={provenance.created ? { id: provenance.created.userId, name: provenance.created.by } : undefined}
              />
              <FreshnessStat
                icon={<PencilLine className="w-4 h-4" />}
                label={provenance.updated?.inDraft ? 'Updated · draft' : 'Updated'}
                iso={provenance.updated?.at}
                tone="indigo"
                loading={summaryQ.isLoading}
                emptyText="No changes yet"
                by={provenance.updated ? { id: provenance.updated.userId, name: provenance.updated.by } : undefined}
              />
            </div>
          ) : (
            <p className="text-[11px] text-ink-muted text-center py-1">
              {unsaved ? 'Save your changes to start this relationship’s history.' : 'History is available with version control.'}
            </p>
          )}
        </DrawerFooter>
      </Tabs>
    </DrawerShell>
  )
}

function ProvenanceRow({ label, mark }: { label: string; mark?: ProvenanceMark }) {
  return (
    <DetailRow label={label}>
      {mark ? (
        <span className="inline-flex items-center gap-1.5 flex-wrap justify-end">
          {mark.at ? <HoverTip label={formatUtc(mark.at)} width="data" className="inline-flex">{timeAgo(mark.at)}</HoverTip> : '—'}
          <span className="text-ink-muted">· by</span>
          <UserAvatar userId={mark.userId} name={mark.by} className="w-4 h-4 text-[8px]" />
          <span className="font-medium">{mark.by}</span>
          {mark.inDraft && <Badge tone="warning">in this draft</Badge>}
        </span>
      ) : '—'}
    </DetailRow>
  )
}
