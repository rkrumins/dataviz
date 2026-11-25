/**
 * RelationshipDrawer — the EntityDrawer for a relationship.
 *
 * Opens when a line is clicked on the canvas. A line that stands for one
 * relationship shows THAT relationship: what it is and means, the two entities
 * it joins (each a click away, on the same back/forward trail as the entity
 * drawer), when and by whom it was created and last changed, its properties,
 * and its full revision history. A line that stands for several shows the
 * connection and lists them. Several relationships — a connection's, the Edge
 * Explorer's selection, a Connections search's picked rows — are compared and
 * edited as one (`MultiRelationshipView`).
 *
 * Raw lineage relationships — the ones a graph's owners author and keep — can
 * be edited (properties), reversed and deleted, in a draft, staged like every
 * other canvas edit; on the published graph, "Edit in a draft" sits in the
 * drawer's top line. A hierarchy link or a relationship of another kind has its
 * properties edited the same way, and only those; a roll-up is read-only, and
 * says why. One not saved yet — drawn, or reversed — is given properties as it
 * is made, and one deleted in the draft is restored from here. Edited, the
 * fields its type defines are held up as an entity's are: each typed as it is
 * defined, their allowed values a click away, a value publishing would refuse
 * said where it is, and a required one it has no value for a row to add.
 *
 * Details come from the drawer's own read (`useRelationshipRecord`), never the
 * canvas copy: canvas edges carry no properties and, from a trace, not even the
 * relationship's real id.
 *
 * Built on the drawer frame and shell: while an edit is unstaged, every move of
 * the drawer asks first.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeftRight, Code, Crosshair, Eye, FileText, History, Info, ListChecks, Pencil, Trash2, Waypoints } from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type LineageNode } from '@/store/canvas'
import { useActiveView } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stagedIndexOf } from '@/store/stagedIndex'
import { useFeature } from '@/store/features'
import { useViewContainmentEdgeTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual } from '@/hooks/useEntityVisual'
import { useRelationshipRecord } from '@/hooks/useRelationshipRecord'
import { edgeKind } from '@/services/ontologyPreflightService'
import { useEntitySummary } from '@/features/versioning/hooks/useVersioning'
import { useEntityBaseline } from '@/features/versioning/hooks/useEntityBaseline'
import { isGhostEdge } from '@/features/versioning/canvas/deletionGhosts'
import { useRestoreGhost } from '@/features/versioning/canvas/useRestoreGhost'
import { useDiscovery } from '@/components/canvas/search/builder/useDiscovery'
import { EDGE_RESERVED_KEYS } from '@/components/canvas/property-manager/op/opModel'
import type { HeldByEdge } from '@/hooks/useCanvasInteractions'
import { userProperties } from '@/lib/nodeFields'
import { fieldWarning, governedFields, inputTypeOf, isPropertyField } from '@/lib/fieldRules'
import { cn } from '@/lib/utils'
import type { EntityFieldDefinition } from '@/types/schema'
import { stageEdgeEdits } from '@/features/versioning/model/stageEdgeEdit'
import { EntityChangeDigest } from './entity/EntityChangeDigest'
import { SchemaFieldInputs } from './entity/EntityEditTab'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import { RelationshipWatchButton } from '@/features/versioning/components/WatchButtons'
import { edgeIndexOf } from '@/lib/storeIndex'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonText } from '@/components/ui/Skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { Section } from './DrawerSection'
import { PropertyEditor, type PropertyEditorProps } from './PropertyEditor'
import { AllowedValuePicker, FieldNote } from './property/FieldGovernance'
import { InlineValue } from './property/InlineValue'
import { PanelErrorBoundary } from './PanelErrorBoundary'
import { useDrawerHistoryScope } from './useDrawerHistoryScope'
import { DrawerBody, DrawerFooter, DrawerFrame, DrawerHeader, DrawerShell } from './shell/DrawerShell'
import { DrawerTopBar, EditInDraftButton, KindBadge } from './shell/DrawerTopBar'
import { DrawerActivity } from './shell/DrawerActivity'
import { CopyableId, EntityRef } from './shell/EntityRef'
import { JsonView } from './shell/JsonView'
import { StageBar } from './shell/StageBar'
import { ConnectionView } from './relationship/ConnectionView'
import { MultiRelationshipView } from './relationship/multi/MultiRelationshipView'
import { Bridge, DetailRow, DetailList, Notice, TypeChip } from './relationship/RelationshipParts'
import { useEndpoints, useOpenEndpoint } from './relationship/useEndpoints'
import { KIND_COPY, openInEdgeExplorer, relationshipCopy } from './relationship/relationshipModel'

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
  /** Stage the reversal of a canvas edge — the canvas's own reverse — with what it holds (the drawer's
   *  read: the canvas line carries none). */
  onReverseEdge?: (canvasEdgeId: string, held: HeldByEdge) => void
  /** Open a draft, so a relationship on the published graph can be changed. */
  onStartEditing?: () => void
}

type RelationshipTarget = Extract<DrawerEdgeTarget, { kind: 'relationship' }>
type ViewMode = 'view' | 'edit' | 'json'

/** Why a relationship on the published graph is read-only: "Edit in a draft"'s tip — or a notice
 *  where the canvas can't open one. */
const PUBLISHED = 'Published — open a draft to change this relationship'

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
    <DrawerFrame panel="relationship-drawer" label="Relationship details" comparing={target.kind === 'relationships'}>
      {target.kind === 'relationship' ? (
        <RelationshipPanel key={`r:${target.id}`} {...props} target={target} onClose={closeDrawer} />
      ) : target.kind === 'relationships' ? (
        // A comparison of many relationships that fails to draw leaves the drawer, and the canvas, standing.
        <PanelErrorBoundary key={`m:${target.id}`} onClose={closeDrawer}>
          <MultiRelationshipView
            target={target}
            onClose={closeDrawer}
            canEdit={props.canEdit}
            writesLocked={props.writesLocked}
            resolveNode={props.resolveNode}
            onLocateMany={props.onLocateMany}
            onStartEditing={props.onStartEditing}
          />
        </PanelErrorBoundary>
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
  onReverseEdge,
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
  // Deleted in this draft and saved: its ghost stands on the canvas until the draft is published.
  const ghost = !!canvasEdge && isGhostEdge(canvasEdge)
  // Not saved yet — drawn, or reversed: what it is given rides on the change that makes it.
  const created = useStagedChangesStore((s) => {
    const c = unsaved ? stagedIndexOf(s.changes).last.get(target.id)?.change : undefined
    return c?.type === 'create_edge' || c?.type === 'reverse_edge' ? c : undefined
  })
  const createdAfter = created?.after as { properties?: Record<string, unknown>; confidence?: number } | undefined
  const type = record?.edgeType ?? target.edgeType
  const kind = edgeKind(type, relationshipTypes, containmentTypes)
  const copy = relationshipCopy(type, relationshipTypes)
  const color = useEdgeVisual(type).strokeColor
  // The fields of its type a publish judges: edited, their rows offer the allowed values and warn
  // of a value publishing would refuse.
  const typeFields = relationshipTypes.find((r) => r.id.toLowerCase() === type.toLowerCase())?.fields
  const typeLabel = `${copy.label} relationships`
  const governed = useMemo(() => {
    const fields = governedFields(typeFields, true)
    return fields.size ? { fields, typeLabel, edges: true } : null
  }, [typeFields, typeLabel])
  const required = useMemo(() => [...(governed?.fields.values() ?? [])].filter((f) => f.required), [governed])
  const confidence = record?.confidence ?? createdAfter?.confidence ?? canvasEdge?.data?.confidence

  const ids = useMemo(() => [target.source, target.target], [target.source, target.target])
  const endpoints = useEndpoints(ids, resolveNode)
  const source = endpoints.get(target.source)!
  const dest = endpoints.get(target.target)!
  const opener = useOpenEndpoint(onFocusNode, resolveNode)

  // ── Its summary: who created and last changed it, as this line (main, or the open draft) has it ──
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
  // The value this line holds, with its token — the baseline an edit is a patch against.
  const stored = summary?.value?.kind === 'edge' && !summary.value.deleted ? summary.value : undefined

  // ── Staged work on this relationship ──
  const pendingEdit = useStagedChangesStore((s) =>
    entityId ? stagedIndexOf(s.changes).edgeEdit.get(entityId) : undefined)
  const pendingDelete = useStagedChangesStore((s) => {
    const { edgeDelete } = stagedIndexOf(s.changes)
    return edgeDelete.get(target.id) ?? (entityId ? edgeDelete.get(entityId) : undefined)
  })
  const storedProps = useMemo(
    () => (stored?.edge.properties ?? record?.properties ?? {}) as Record<string, unknown>, [stored, record])
  const baseVersion = stored?.version ?? record?.version
  const shownProps = useMemo(
    () => ((pendingEdit?.after as { properties?: Record<string, unknown> } | undefined)?.properties)
      ?? createdAfter?.properties ?? storedProps,
    [pendingEdit, createdAfter, storedProps],
  )
  // In a draft, what is published (main where the draft began): its properties then say what the
  // draft changed, saved or not yet — as an entity's do.
  const baseline = useEntityBaseline(versioningEnabled ? scope : {}, unsaved ? null : entityId)
  const publishedProps = useMemo(
    () => (baseline ? userProperties(baseline.published.properties) : undefined), [baseline])
  // The required fields it holds no key for — one removed is listed as removed, with Restore. New
  // in the draft, publishing refuses it until each has a value.
  const missingIn = (props: Record<string, unknown>) =>
    required.filter((f) => !(f.id in props) && !(publishedProps && f.id in publishedProps))
  const refusedNew = unsaved || baseline?.status === 'added'
  const unsavedFields = useMemo(() => {
    if (!pendingEdit) return 0
    const b = ((pendingEdit.before as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}
    const a = ((pendingEdit.after as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).length
  }, [pendingEdit])

  // ── Can this relationship be changed here? ──
  // Its properties, on every kind but a roll-up (the aggregation job's); reversed and deleted, only
  // lineage. One not saved yet has nothing stored, nor a history, to be checked against.
  const editable = kind !== 'rollup' && !writesLocked && versioningEnabled && editModeEnabled && canEdit
    && !pendingDelete && (unsaved ? !!created : !!record && tracked)
  // The fields of its type, each edited as its type in Edit — optional ones too.
  const schemaFields = useMemo(() => (typeFields ?? []).filter((f) => isPropertyField(f, true)), [typeFields])
  const restoreGhost = useRestoreGhost()
  const restore = ghost && canEdit && !writesLocked ? () => { void restoreGhost(canvasEdge!.id) } : undefined
  const openReview = () => useStagedChangesStore.getState().openReviewPanel()
  const readOnly = ((): { tone: 'info' | 'warn'; text: string; action?: { label: string; onClick: () => void }; draft?: boolean } | null => {
    if (ghost) {
      return { tone: 'warn', text: 'Deleted in this draft — it goes once the draft is published. Restore brings it back as it was.',
        action: restore && { label: 'Restore', onClick: restore } }
    }
    if (kind === 'rollup') return { tone: 'info', text: KIND_COPY.rollup.readOnly! }
    if (unsaved) {
      // What it will need before it is published, said while it is made — as a new entity's fields are.
      const needs = required.length > 0
        ? ` ${typeLabel} need ${required.map((f) => f.name || f.id).join(', ')} before they can be published.` : ''
      return { tone: 'warn', text: `Not saved yet — save your changes to see its history.${needs}`, action: { label: 'Review & Save', onClick: openReview } }
    }
    if (pendingDelete) {
      return { tone: 'warn', text: 'Deletion staged — it is removed when you save, or discard it in Review.', action: { label: 'Review', onClick: openReview } }
    }
    if (writesLocked) return { tone: 'info', text: 'Read-only while tracing.' }
    if (!versioningEnabled || !editModeEnabled) return null
    if (!canEdit) return { tone: 'info', text: `${PUBLISHED}.`, draft: true }
    if (recordLoading || (historyOn && summaryQ.isLoading)) return null
    if (!record) return { tone: 'warn', text: 'This relationship could not be found in the graph, so it can’t be edited here.' }
    if (historyOn && !tracked) return { tone: 'info', text: 'Not under version control yet, so it can’t be edited here.' }
    // A hierarchy link or another kind: what is not changed here, beside its properties.
    const note = KIND_COPY[kind].readOnly
    return note ? { tone: 'info', text: note } : null
  })()
  // On the published graph, the way to a draft is in the top line, and its tip says why.
  const offerDraft = !!readOnly?.draft && !!onStartEditing
  const readOnlyNotice = offerDraft ? null : readOnly

  // ── View / edit state ──
  const [mode, setMode] = useState<ViewMode>('view')
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [justStaged, setJustStaged] = useState(false)
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
  // Edit's typed fields change the draft as the property list does; "Stage changes" stages it.
  const editDraft = (update?: (d: Record<string, unknown>) => Record<string, unknown>) => {
    if (!update) return
    setDraft(update)
    setHasChanges(true)
    setJustStaged(false)
  }

  const stagedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(stagedTimer.current), [])
  // What was read, and its token — the diff base for the save and its concurrency check. A later
  // re-stage keeps the first one (`stageEdgeEdits`).
  const editOf = (after: Record<string, unknown>) => ({
    edgeId: entityId!,
    current: { properties: storedProps, ...(baseVersion ? { version: baseVersion } : {}) },
    after,
    summary: `Edit relationship '${source.name}' → '${dest.name}'`,
  })
  const stage = () => {
    if ((!record && !created) || !entityId || !hasChanges) return
    stageEdgeEdits([editOf(draft)])
    setHasChanges(false)
    setMode('view')
    setJustStaged(true)
    clearTimeout(stagedTimer.current)
    stagedTimer.current = setTimeout(() => setJustStaged(false), 2500)
  }

  // Edited where it is read (the View tab, in a draft): each change is staged as it is made. Back
  // to the properties as read, nothing is left staged.
  const [addingInline, setAddingInline] = useState(false)
  const stageInline = (next: Record<string, unknown>) => {
    if ((!record && !created) || !entityId) return
    stageEdgeEdits([editOf(next)])
  }

  const canDelete = !!onDeleteEdge && kind === 'lineage' && !writesLocked && !!canvasEdge
    && canvasEdge.id === entityId && !pendingDelete && !ghost
  const deleteRelationship = () => useCanvasStore.getState().requestDrawerMove(() => {
    onDeleteEdge!(canvasEdge!.id)
    useCanvasStore.getState().closeNodeDrawer()
  })
  const canReverse = !!onReverseEdge && editable && !unsaved && kind === 'lineage' && canvasEdge?.id === entityId
  // Saved as a new relationship, pointing the other way, with what this one holds as shown — its
  // staged edit too.
  const reverseRelationship = () => useCanvasStore.getState().requestDrawerMove(() => {
    onReverseEdge!(canvasEdge!.id, { properties: shownProps, ...(typeof confidence === 'number' ? { confidence } : {}) })
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
  // A property the draft removed is still listed (struck through, with Restore while editing).
  const removedSome = !!publishedProps && Object.keys(publishedProps).some((k) => !(k in shownProps))
  const sectionsKey = `edge:${type}`
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
            action={offerDraft && onStartEditing ? <EditInDraftButton onClick={onStartEditing} reason={PUBLISHED} /> : undefined}
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
            <Button
              size="sm"
              variant="subtle"
              leftIcon={Waypoints}
              onClick={() => useCanvasStore.getState().requestDrawerMove(() => openInEdgeExplorer(canvasEdge ? [canvasEdge.id] : []))}
            >
              Edge Explorer
            </Button>
            {/* Watching it, as an entity is watched: by its id, once it has history to watch. */}
            {historyOn && !unsaved && entityId && (
              <RelationshipWatchButton wsId={scope.wsId!} graphId={scope.graphId!} edgeId={entityId}
                name={`${source.name} → ${dest.name}`} />
            )}
            {canReverse && (
              <HoverTip label="Point it the other way" detail="Saved as a new relationship: its properties go with it, its history starts over" className="inline-flex">
                <Button size="sm" variant="subtle" leftIcon={ArrowLeftRight} onClick={reverseRelationship}>
                  Reverse direction
                </Button>
              </HoverTip>
            )}
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
            {(baseline || unsavedFields > 0) && (
              <div className="px-5 pt-4 -mb-3">
                <EntityChangeDigest baseline={baseline} unsavedFields={unsavedFields} kind="edge" />
              </div>
            )}
            <div className="divide-y divide-glass-border">
              <Section title="Details" icon={Info}>
                <DetailList>
                  <DetailRow label="Relationship">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <TypeChip type={type} label={copy.label} />
                      {copy.label.toUpperCase() !== type.toUpperCase() && <code className="text-[11px] font-mono text-ink-muted">{type}</code>}
                    </span>
                  </DetailRow>
                  <DetailRow label="Meaning">{copy.description ?? KIND_COPY[kind].meaning}</DetailRow>
                  <DetailRow label="Kind">{KIND_COPY[kind].label}</DetailRow>
                  <DetailRow label="From"><EntityRef endpoint={source} onOpen={opener.open} /></DetailRow>
                  <DetailRow label="To"><EntityRef endpoint={dest} onOpen={opener.open} /></DetailRow>
                  <DetailRow label="ID"><CopyableId id={entityId ?? target.id} /></DetailRow>
                </DetailList>
              </Section>

              <Section title="Properties" icon={FileText} flush={hasProps}>
                {recordLoading && !pendingEdit ? (
                  <SkeletonText lines={3} />
                ) : recordError ? (
                  <Notice tone="warn" action={{ label: 'Retry', onClick: () => { void refetch() } }}>
                    <span className="inline-flex items-center gap-2"><AlertCircle className="w-4 h-4" aria-hidden />Couldn’t load this relationship’s properties.</span>
                  </Notice>
                ) : hasProps || removedSome || (editable && addingInline) ? (
                  <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
                    {editable && (
                      <MissingFields fields={missingIn(shownProps)} typeLabel={typeLabel} refused={refusedNew}
                        onAdd={(key, value) => stageInline({ ...shownProps, [key]: value })} />
                    )}
                    {editable ? (
                      <EditedProperties key={entityId ?? target.id} edgeType={type} value={shownProps} onChange={(next) => stageInline(next as Record<string, unknown>)}
                        inline original={unsaved ? undefined : storedProps} published={publishedProps} startAdding={addingInline && !hasProps}
                        searchable groupByPath bare sectionsKey={sectionsKey} governed={governed} />
                    ) : (
                      <PropertyEditor value={shownProps} onChange={() => {}} readOnly published={publishedProps}
                        searchable groupByPath bare sectionsKey={sectionsKey} />
                    )}
                  </PanelErrorBoundary>
                ) : (
                  <>
                    {editable && (
                      <MissingFields fields={missingIn(shownProps)} typeLabel={typeLabel} refused={refusedNew}
                        onAdd={(key, value) => stageInline({ ...shownProps, [key]: value })} />
                    )}
                    <EmptyState compact icon={FileText} title="No properties yet"
                      description={!editable ? undefined : kind === 'lineage' ? 'Record what this flow carries, how often, who owns it.' : 'Record anything worth knowing about it.'}
                      action={editable ? { label: 'Add properties', onClick: () => setAddingInline(true) } : undefined} />
                  </>
                )}
              </Section>

              {historyOn && !unsaved && entityId && (
                <div id={`history-${entityId}`} className="scroll-mt-2">
                <Section title="History" icon={History}>
                  <EntityHistory
                    wsId={scope.wsId!}
                    graphId={scope.graphId!}
                    entityId={entityId}
                    mainBranchId={scope.mainBranchId}
                    branchId={scope.branchId}
                    kind="edge"
                    onRestore={restore}
                  />
                </Section>
                </div>
              )}
            </div>
          </TabsContent>

          {editable && (
            <TabsContent value="edit">
              {schemaFields.length > 0 && (
                <Section title="Schema properties" icon={ListChecks}>
                  <SchemaFieldInputs fields={schemaFields} form={draft} original={refusedNew ? null : storedProps}
                    read={(d, id) => d[id]} write={(d, id, v) => ({ ...d, [id]: v })} typeLabel={typeLabel} edges
                    onEdit={editDraft} onCommit={editDraft} onCancel={() => {}} />
                </Section>
              )}
              <Section title="Properties" icon={FileText} flush>
                <PanelErrorBoundary resetKeys={[entityId ?? target.id]}>
                  <EditedProperties
                    edgeType={type}
                    value={draft}
                    onChange={(next) => {
                      setDraft(next as Record<string, unknown>)
                      setHasChanges(true)
                      setJustStaged(false)
                    }}
                    original={unsaved ? undefined : storedProps}
                    published={publishedProps}
                    searchable
                    groupByPath
                    bare
                    sectionsKey={sectionsKey}
                    governed={governed}
                  />
                </PanelErrorBoundary>
              </Section>
            </TabsContent>
          )}

          <TabsContent value="json">
            <JsonView data={jsonData} label="Relationship data" />
          </TabsContent>
        </DrawerBody>

        <DrawerFooter>
          {editing ? (
            <StageBar dirty={hasChanges} justStaged={justStaged} onCancel={discard} onStage={stage} />
          ) : historyOn && !unsaved ? (
            <DrawerActivity summary={summary} loading={summaryQ.isLoading} wsId={scope.wsId} graphId={scope.graphId} inDraft={!!draftId}
              onSeeHistory={entityId ? () => {
                setMode('view')
                requestAnimationFrame(() => document.getElementById(`history-${entityId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
              } : undefined} />
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

/** An edited relationship's properties, offering — as a property is added — the names others of its
 *  type carry in the view's discovery sample, each with a value or two it holds. Mounted only where
 *  they are edited, so the sample is asked for only then. */
function EditedProperties({ edgeType, ...props }: PropertyEditorProps & { edgeType: string }) {
  const { keysByEdgeType, getEdgeValueSamples } = useDiscovery(useActiveView()?.id ?? null)
  const suggestions = useMemo(() => {
    const at = Object.keys(keysByEdgeType).find((t) => t.toLowerCase() === edgeType.toLowerCase())
    return (at ? keysByEdgeType[at]! : []).filter((key) => !EDGE_RESERVED_KEYS.has(key)).map((key) => ({
      key,
      count: 0,
      examples: getEdgeValueSamples(at!, key)
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map(String).filter((v) => v.length <= 40).slice(0, 2),
    }))
  }, [keysByEdgeType, getEdgeValueSamples, edgeType])
  return <PropertyEditor {...props} suggestions={suggestions} />
}

/** The required fields of its type it holds no value for, each a row to add one in — typed as the
 *  field is, its allowed values a click away. `refused`: it is new in the draft, so publishing
 *  refuses it until each has one (said, never a block); one that predates the rule stays
 *  publishable, and the rows only offer the value. */
function MissingFields({ fields, typeLabel, refused, onAdd }: {
  fields: readonly EntityFieldDefinition[]
  /** Its type, as the warnings name it ("Owns relationships"). */
  typeLabel: string
  refused: boolean
  onAdd: (key: string, value: unknown) => void
}) {
  if (fields.length === 0) return null
  return (
    <ul aria-label="Required fields without a value" className="mb-3 space-y-2">
      {fields.map((f) => {
        const label = f.name || f.id
        const type = inputTypeOf(f.type)
        const warning = refused ? fieldWarning(f, undefined, typeLabel, true) : null
        return (
          <li key={f.id} className={cn('rounded-lg border border-dashed px-3 py-2',
            refused ? 'border-amber-500/40 bg-amber-500/[0.04]' : 'border-black/[0.10] dark:border-white/[0.12]')}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="min-w-0 truncate text-xs font-mono text-ink-secondary">{f.id}</span>
              <span className="shrink-0 text-2xs text-ink-muted">Required</span>
            </div>
            <div className="mt-1">
              <InlineValue value={undefined} fieldType={type} fieldLabel={label} onCommit={(v) => onAdd(f.id, v)}
                readView={<span className="text-xs font-medium text-accent-lineage">Add {label}…</span>} />
            </div>
            {(f.allowedValues?.length ?? 0) > 0 && type !== 'boolean' && (
              <AllowedValuePicker field={f} value={undefined} label={label} onPick={(v) => onAdd(f.id, v)} className="mt-1.5" />
            )}
            {warning && <FieldNote className="mt-1.5">{warning}</FieldNote>}
          </li>
        )
      })}
    </ul>
  )
}
