/**
 * EntityDrawer — an entity's details, and (in a draft) its editor.
 *
 * - **View**: its identifier and details, where it sits, its properties, classifications, lineage
 *   and history. **Edit** (in a draft only — the published graph offers to open one): name,
 *   business label, description, schema fields, placement and properties. **JSON**: read-only.
 * - Property values are plain JSON; friendly field types are inferred from the value on read
 *   (property/fieldTypes.ts), so nothing extra is persisted.
 * - An edit stages ONE change per node (`stageNodeEdit`), saved with the draft as a patch against
 *   the node as first read: changed fields, set properties, and each removed property named in
 *   `unsetProperties`. Where a field lives is decided by `lib/nodeFields`.
 * - Built on `DrawerShell`: while an edit is unstaged, every move of the drawer — a canvas click,
 *   the trail, Esc, a trace — asks first.
 *
 * The drawer shows whichever entity it was last opened on (`drawerNodeId`), independent of the
 * canvas highlight; it stays open until closed.
 */
import { memo, useCallback, useId, useMemo, useState } from 'react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePersonaStore } from '@/store/persona'
import { useFeature } from '@/store/features'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import { useEntitySummary, useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { useRestoreGhost } from '@/features/versioning/canvas/useRestoreGhost'
import { NO_VERSION_CONTROL, useEntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import { resolveEntityName, technicalSubtitle } from '@/lib/entityDisplayName'
import { userProperties } from '@/lib/nodeFields'
import { nodeIndexOf } from '@/lib/storeIndex'
import type { RevealSearchHit } from '@/hooks/useRevealSearchHit'
import { Tabs, TabsContent } from '@/components/ui/Tabs'
import { DrawerBody, DrawerFrame, DrawerShell } from '../shell/DrawerShell'
import { JsonView } from '../shell/JsonView'
import { useDrawerHistoryScope } from '../useDrawerHistoryScope'
import { useEntityEditSession } from './useEntityEditSession'
import { EntityHeader, type EntityTab } from './EntityHeader'
import { EntityViewTab } from './EntityViewTab'
import { EntityEditTab } from './EntityEditTab'
import { EntityFooter } from './EntityFooter'

export interface EntityDrawerProps {
  /** The canvas owning this drawer accepts graph edits — a draft, in edit mode.
   *  Without it the drawer is read-only; the published graph is never edited in place. */
  canEdit?: boolean
  /** Offered on a read-only drawer over the published graph: start editing in a draft. */
  onStartEditing?: () => void
  /** Writes are refused by the surface that owns this drawer — currently a canvas trace, which is
   *  read-only for its whole life. Hides the Edit tab, so the drawer cannot offer what the canvas
   *  would reject. */
  writesLocked?: boolean
  /** Open the Lineage Lens (ego-graph overlay) on this node. */
  onFocusConnections?: (nodeId: string) => void
  onTraceUp?: (nodeId: string) => void
  onTraceDown?: (nodeId: string) => void
  onFullTrace?: (nodeId: string) => void
  /** Reveal on canvas — expands collapsed ancestors (lazy-loading if needed), then pans to it. May
   *  report a `RevealOutcome`: 'unavailable' means the walk finished and it is still not there. */
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  /** Reveal a set of neighbours at once and fit the canvas around them. */
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  /** Open the canvas down a KNOWN containment path to an entity at any depth. */
  onRevealPath?: RevealSearchHit
  /** External link URL builder */
  getExternalUrl?: (urn: string) => string | null
  /** Entities the surface is DRAWING that the canvas store does not hold — a trace overlay's
   *  partner cards, which come from the walk model and are never written to the store. Consulted
   *  only when the store has no node with this id. */
  resolveNode?: (id: string) => LineageNode | null
}

/** Memoised: a canvas re-rendering (a pan, a hover, a pulse) never re-renders the drawer. */
export const EntityDrawer = memo(function EntityDrawer({ resolveNode, ...props }: EntityDrawerProps) {
  // Logical nodes ("logical:…") are virtual groupings, not entities — they have no drawer.
  const drawerNodeId = useCanvasStore((s) => (s.drawerNodeId && !s.drawerNodeId.startsWith('logical:') ? s.drawerNodeId : null))
  const storeNode = useCanvasStore((s) => (drawerNodeId ? nodeIndexOf(s.nodes).get(drawerNodeId) ?? null : null))
  // A trace draws its partners from the walk model and writes nothing to the store; the surface
  // drawing them can answer for them — asked only after the store has missed.
  const node = storeNode ?? (drawerNodeId ? resolveNode?.(drawerNodeId) ?? null : null)
  if (!node) return null
  return <OpenEntityDrawer node={node} {...props} />
})

function OpenEntityDrawer({
  node, canEdit = false, onStartEditing, writesLocked = false, onFocusConnections, onTraceUp, onTraceDown,
  onFullTrace, onFocusNode, onLocateMany, onRevealPath, getExternalUrl,
}: Omit<EntityDrawerProps, 'resolveNode'> & { node: LineageNode }) {
  const data = node.data as Record<string, unknown>
  const typeId = (data.type as string | undefined) ?? ''
  const entityType = useSchemaStore((s) => s.schema?.entityTypes.find((t) => t.id === typeId) ?? null)
  const colors = useEntityColorSet(typeId)
  const personaMode = usePersonaStore((s) => s.mode)
  const versioningEnabled = useFeature('versioningEnabled')

  // ── What is stored: the summary for the line being read (a draft sees main at its branch
  // point plus its own edits) — its last change, and its current value and token. ──
  const scope = useDrawerHistoryScope()
  const draftId = scope.branchId && scope.branchId !== scope.mainBranchId ? scope.branchId : null
  const unsavedCreate = data.isPending === 'create'
  const summaryQ = useEntitySummary(
    versioningEnabled ? scope.wsId : undefined,
    versioningEnabled ? scope.graphId : undefined,
    unsavedCreate ? undefined : ((data.urn as string | undefined) ?? node.id),
    { branchId: draftId, kind: 'node', includeValue: true },
  )
  const watermark = useProjectionWatermark(scope.wsId, scope.graphId)

  // ── The edit ──
  const session = useEntityEditSession(node, summaryQ.data?.value)
  const { form, dirty, justStaged, edit, stage, discard } = session
  const isGhost = data.isGhost === true
  // An edit is kept only as a change in a draft (useEntityEditing). Where editing isn't offered at
  // all — switched off, a read-only view, a ghost, a locked surface — nothing is offered; where it
  // is but can't be kept here yet, the header says why (or offers a draft).
  const editing = useEntityEditing()
  const editOffered = !isGhost && !writesLocked && editing.offered
  const editable = canEdit && editOffered && !editing.blocked

  // A new entity opens on View; a drawer that cannot edit (a trace began) never shows Edit.
  const [tab, setTab] = useState<EntityTab>('view')
  const [tabFor, setTabFor] = useState(node.id)
  if (tabFor !== node.id) {
    setTabFor(node.id)
    setTab('view')
  }
  const shownTab: EntityTab = tab === 'edit' && !editable ? 'view' : tab

  const urn = (form.urn as string | undefined) || node.id
  const userProps = useMemo(() => userProperties(form.properties), [form.properties])
  const title = useMemo(() => resolveEntityName(node.data, personaMode, node.id), [node.data, personaMode, node.id])
  const technicalLine = useMemo(() => technicalSubtitle(node.data, personaMode), [node.data, personaMode])
  const externalUrl = useMemo(() => getExternalUrl?.(urn) ?? null, [getExternalUrl, urn])

  const [copiedUrn, setCopiedUrn] = useState(false)
  const copyUrn = useCallback(() => {
    void navigator.clipboard?.writeText(urn)
    setCopiedUrn(true)
    setTimeout(() => setCopiedUrn(false), 2000)
  }, [urn])

  const restoreGhost = useRestoreGhost()
  const close = useCallback(() => useCanvasStore.getState().requestDrawerMove(() => {
    const s = useCanvasStore.getState()
    s.closeNodeDrawer()
    s.clearSelection()
  }), [])
  const cancelEdit = useCallback(() => {
    discard()
    setTab('view')
  }, [discard])
  const startEdit = useCallback(() => setTab('edit'), [])

  const titleId = useId()
  return (
    <DrawerFrame panel="entity-drawer" label="Entity details">
      <DrawerShell
        titleId={titleId}
        focusKey={node.id}
        dirty={dirty}
        dirtyWhat={<>your changes to <span className="font-semibold text-ink">{title}</span></>}
        onClose={close}
        onStage={stage}
        canStage={dirty}
        onDiscard={discard}
      >
        <Tabs value={shownTab} onValueChange={(v) => setTab(v as EntityTab)} className="flex flex-col flex-1 min-h-0">
          <EntityHeader
            nodeId={node.id}
            titleId={titleId}
            typeName={entityType?.name || typeId}
            colors={colors}
            confidence={typeof form.confidence === 'number' ? form.confidence : undefined}
            title={title}
            technicalLine={technicalLine}
            isGhost={isGhost}
            onRestore={() => restoreGhost((data.urn as string | undefined) || node.id)}
            onTraceUp={onTraceUp}
            onTraceDown={onTraceDown}
            onFullTrace={onFullTrace}
            onFocusConnections={onFocusConnections}
            copiedUrn={copiedUrn}
            onCopyUrn={copyUrn}
            externalUrl={externalUrl}
            editable={editable}
            dirty={dirty}
            editBlocked={editOffered && !editable ? editing.blocked : null}
            onStartEditing={editOffered && editing.blocked !== NO_VERSION_CONTROL ? onStartEditing : undefined}
            onClose={close}
            onFocusNode={onFocusNode}
          />

          <DrawerBody>
            <TabsContent value="view">
              <EntityViewTab
                nodeId={node.id}
                form={form}
                urn={urn}
                childCount={Number(form.childCount || form._collapsedChildCount || 0)}
                tagColors={colors}
                userProps={userProps}
                copiedUrn={copiedUrn}
                onCopyUrn={copyUrn}
                canEdit={editable}
                onStartEdit={startEdit}
                onFocusNode={onFocusNode}
                onLocateMany={onLocateMany}
                onRevealPath={onRevealPath}
                history={scope}
              />
            </TabsContent>
            {editable && (
              <TabsContent value="edit">
                <EntityEditTab
                  nodeId={node.id}
                  form={form}
                  entityType={entityType}
                  urn={urn}
                  userProps={userProps}
                  onEdit={edit}
                  onCopyUrn={copyUrn}
                />
              </TabsContent>
            )}
            <TabsContent value="json">
              <JsonView data={form} label="Entity data as JSON" />
            </TabsContent>
          </DrawerBody>

          <EntityFooter
            editing={shownTab === 'edit' || dirty || justStaged}
            dirty={dirty}
            justStaged={justStaged}
            onCancel={cancelEdit}
            onStage={stage}
            summary={summaryQ.data}
            summaryLoading={summaryQ.isLoading}
            watermark={watermark.data}
            externalUrl={externalUrl}
          />
        </Tabs>
      </DrawerShell>
    </DrawerFrame>
  )
}
