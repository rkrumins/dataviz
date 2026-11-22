/**
 * MultiRelationshipView — several relationships, read and edited as one, in the relationship drawer.
 *
 * Opened on a connection's relationships ("Compare & edit"), the Edge Explorer's selection or the
 * rows picked in a Connections search, it holds the relationships it was opened on.
 *
 * - **Reading.** Each property is Same on all of them, Differs, or held by only some; opening a
 *   row shows every value and which relationships hold it — read in one request, as main or the
 *   open draft has them (`useRelationshipRecords`), never the canvas copy (lines carry no
 *   properties).
 * - **Who is compared.** Authored lineage relationships, as they are stored. Roll-ups, hierarchy
 *   links, relationships not saved yet, deleted in the draft or with a deletion staged are left out,
 *   each listed with why. Each is named by its ends ("Orders → Revenue"); a list opened on them
 *   adds each one's ID beneath.
 * - **Editing**, in a draft: set a value for all, fill where missing, rename, copy, remove, add a
 *   property to all — pending until "Stage", then staged as each relationship's own edit in one
 *   step that Undo takes back (`stageEdgeEdits`). Unstaged changes hold every move of the drawer.
 * - **Scale.** Up to `MULTI_RELATIONSHIP_MAX` relationships are compared here; more — or any
 *   number, on purpose — are changed on the server, by a job (Property Manager's dialog).
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AlertCircle, ChevronDown, Crosshair, Database, Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore, type DrawerEdgeTarget, type EdgeMemberRef, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stagedIndexOf } from '@/store/stagedIndex'
import { useFeature } from '@/store/features'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useViewContainmentEdgeTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useRelationshipRecords, type RelationshipRecordOf } from '@/hooks/useRelationshipRecords'
import { edgeKind } from '@/services/ontologyPreflightService'
import { NO_VERSION_CONTROL, VIEW_ONLY_DRAFT, useEntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import { stageEdgeEdits, type EdgeEdit } from '@/features/versioning/model/stageEdgeEdit'
import { targetFromMember } from '@/lib/drawerEdgeTarget'
import { userProperties } from '@/lib/nodeFields'
import { useAppNotifications } from '@/components/ui/notifications'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SkeletonText } from '@/components/ui/Skeleton'
import {
  bulkEditSize, isEmptyBulkEdit, patchFor, previewBulkEdit, sharedFields, type BulkEdit,
} from '@/components/canvas/context-view/bulkEdit'
import { DrawerBody, DrawerFooter, DrawerHeader, DrawerShell } from '../../shell/DrawerShell'
import { DrawerTopBar } from '../../shell/DrawerTopBar'
import { useDrawerHistoryScope } from '../../useDrawerHistoryScope'
import { EMPTY_EDIT, withChange, type KeyChange } from '../../entity/multi/editOps'
import { MultiProperties } from '../../entity/multi/MultiProperties'
import { MemberList, type Member } from '../../entity/multi/ValueBreakdown'
import { Notice, TypeChip } from '../RelationshipParts'
import { useEndpoints } from '../useEndpoints'
import { KIND_COPY, openInEdgeExplorer, relationshipCopy } from '../relationshipModel'

/** Relationships compared and edited here at once; more are changed on the server. */
export const MULTI_RELATIONSHIP_MAX = 1000

const STAGED_MARK_MS = 2500
const NO_SUGGESTIONS = () => []
const NOT_REFUSED = () => null

type RelationshipsTarget = Extract<DrawerEdgeTarget, { kind: 'relationships' }>

/** A relationship compared: as read, and as shown — with what is staged on it. */
interface Held { id: string; member: EdgeMemberRef; record: RelationshipRecordOf; properties: Record<string, unknown> }

export function MultiRelationshipView({
  target, onClose, canEdit = false, writesLocked = false, resolveNode, onLocateMany, onStartEditing,
}: {
  target: RelationshipsTarget
  onClose: () => void
  canEdit?: boolean
  writesLocked?: boolean
  resolveNode?: (id: string) => LineageNode | null
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  onStartEditing?: () => void
}) {
  const relationshipTypes = useViewRelationshipTypes()
  const containmentTypes = useViewContainmentEdgeTypes()
  const versioningEnabled = useFeature('versioningEnabled')
  const scope = useDrawerHistoryScope()
  const draftId = scope.branchId && scope.branchId !== scope.mainBranchId ? scope.branchId : null
  const titleId = useId()

  const tooMany = target.members.length > MULTI_RELATIONSHIP_MAX
  const compared = useMemo(() => target.members.slice(0, MULTI_RELATIONSHIP_MAX), [target.members])

  // ── Read once for all of them — all but the ones not saved yet and the roll-ups ──
  const unsaved = useStagedChangesStore(useShallow((s) => {
    const created = new Set<string>()
    for (const c of s.changes) if (c.type === 'create_edge') created.add(c.targetId)
    return compared.map((m) => created.has(m.id))
  }))
  const toRead = useMemo(() => compared.filter((m, i) => !unsaved[i] && !m.rollup), [compared, unsaved])
  const read = useRelationshipRecords(toRead, versioningEnabled
    ? { wsId: scope.wsId, graphId: scope.graphId, branchId: draftId } : {})

  // ── Staged work on them, re-read only when theirs changes ──
  const entityIds = useMemo(() => toRead.map((m) => read.records.get(m.id)?.entityId ?? m.id), [toRead, read.records])
  const pendingEdits = useStagedChangesStore(useShallow((s) => {
    const { edgeEdit } = stagedIndexOf(s.changes)
    return entityIds.map((id) => edgeEdit.get(id) ?? null)
  }))
  const pendingDeletes = useStagedChangesStore(useShallow((s) => {
    const { edgeDelete } = stagedIndexOf(s.changes)
    return toRead.map((m, i) => !!(edgeDelete.get(m.id) ?? edgeDelete.get(entityIds[i]!)))
  }))

  // ── Who is compared, and who is left out and why ──
  const { held, excluded } = useMemo(() => {
    const held: Held[] = []
    const excluded: Array<{ member: EdgeMemberRef; reason: string }> = []
    const at = new Map(toRead.map((m, i) => [m.id, i]))
    compared.forEach((m, i) => {
      if (unsaved[i]) { excluded.push({ member: m, reason: 'Not saved yet' }); return }
      if (m.rollup) { excluded.push({ member: m, reason: 'A roll-up — read-only' }); return }
      const record = read.records.get(m.id)
      if (!record) {
        if (read.deleted.has(m.id)) excluded.push({ member: m, reason: 'Deleted in this draft' })
        else if (read.missing.has(m.id)) excluded.push({ member: m, reason: 'Not found in the graph' })
        return
      }
      const kind = edgeKind(record.edgeType || m.edgeType, relationshipTypes, containmentTypes)
      if (kind !== 'lineage') { excluded.push({ member: m, reason: `${KIND_COPY[kind].label} — read-only` }); return }
      if (read.versioned && !record.version) { excluded.push({ member: m, reason: 'Not under version control yet' }); return }
      const j = at.get(m.id)!
      if (pendingDeletes[j]) { excluded.push({ member: m, reason: 'Deletion staged' }); return }
      const staged = (pendingEdits[j]?.after as { properties?: Record<string, unknown> } | undefined)?.properties
      held.push({ id: m.id, member: m, record, properties: staged ?? record.properties })
    })
    return { held, excluded }
  }, [compared, toRead, unsaved, read.records, read.deleted, read.missing, read.versioned, pendingEdits, pendingDeletes,
    relationshipTypes, containmentTypes])
  const heldIds = useMemo(() => held.map((h) => h.id), [held])
  const fields = useMemo(() => sharedFields(held.map((h) => ({ id: h.id, data: { properties: h.properties } }))), [held])

  // ── Their names: "Source → Target" ──
  const ends = useMemo(() => [...new Set(compared.flatMap((m) => [m.source, m.target]))], [compared])
  const endpoints = useEndpoints(ends, resolveNode)
  const byId = useMemo(() => new Map(compared.map((m) => [m.id, m])), [compared])
  const endsOf = useCallback((m: EdgeMemberRef) =>
    [endpoints.get(m.source)?.name ?? m.source, endpoints.get(m.target)?.name ?? m.target] as const, [endpoints])
  const nameOf = useCallback((m: EdgeMemberRef) => endsOf(m).join(' → '), [endsOf])
  const memberOf = useCallback((id: string): Member => {
    const m = byId.get(id)
    if (!m) return { id, name: 'Not loaded', ident: id, notLoaded: true }
    // Its ID as stored, where it was read — what the single drawer shows.
    return { id, name: nameOf(m), ident: read.records.get(id)?.entityId ?? id }
  }, [byId, nameOf, read.records])
  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const h of held) counts.set(h.record.edgeType || h.member.edgeType, (counts.get(h.record.edgeType || h.member.edgeType) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [held])

  // ── Whether they can be edited here ──
  const editing = useEntityEditing()
  const editOffered = !writesLocked && editing.offered
  const editable = canEdit && editOffered && !editing.blocked && read.versioned && !tooMany && held.length > 0

  // ── The edit: one pending change per property, kept until staged ──
  const [edit, setEdit] = useState<BulkEdit>(EMPTY_EDIT)
  const dirty = editable && !isEmptyBulkEdit(edit)
  const onChange = useCallback((key: string, change: KeyChange | null) => setEdit((e) => withChange(e, key, change)), [])
  const onAddAll = useCallback((entries: Array<[string, unknown]>) =>
    setEdit((e) => entries.reduce((acc, [k, value]) => withChange(acc, k, { kind: 'set', value }), e)), [])
  const preview = useMemo(
    () => (dirty ? previewBulkEdit(held.map((h) => ({ data: { properties: h.properties } })), edit) : null), [dirty, held, edit])

  const { notify } = useAppNotifications()
  const [staged, setStaged] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (staged.size === 0) return
    const t = setTimeout(() => setStaged(new Set()), STAGED_MARK_MS)
    return () => clearTimeout(t)
  }, [staged])

  const stage = useCallback(() => {
    if (!dirty || !preview || preview.entities === 0) return
    const touched = new Set([
      ...Object.keys(edit.set), ...Object.keys(edit.fill ?? {}), ...edit.unset,
      ...(edit.moves ?? []).flatMap((m) => [m.from, m.to]),
    ])
    const edits: EdgeEdit[] = []
    for (const h of held) {
      const p = patchFor(userProperties(h.properties), edit)
      if (Object.keys(p.set).length === 0 && p.unset.length === 0) continue
      const after: Record<string, unknown> = { ...h.properties, ...p.set }
      for (const k of p.unset) delete after[k]
      const [from, to] = endsOf(h.member)
      edits.push({
        edgeId: h.record.entityId,
        current: { properties: h.record.properties, ...(h.record.version ? { version: h.record.version } : {}) },
        after,
        summary: `Edit relationship '${from}' → '${to}'`,
      })
    }
    const step = stageEdgeEdits(edits)
    const size = bulkEditSize(edit)
    notify('success',
      `Staged ${size.toLocaleString()} ${size === 1 ? 'change' : 'changes'} on ${preview.entities.toLocaleString()} ${preview.entities === 1 ? 'relationship' : 'relationships'} — Review & Save keeps them.`,
      { label: 'Undo', onClick: () => {
        const s = useStagedChangesStore.getState()
        if (step && s.past[s.past.length - 1]?.id === step) s.undo()
      } })
    setEdit(EMPTY_EDIT)
    setStaged(touched)
  }, [dirty, preview, edit, held, endsOf, notify])
  const discard = useCallback(() => setEdit(EMPTY_EDIT), [])

  // ── Moves ──
  const openOne = useCallback((id: string) => {
    const m = byId.get(id)
    if (m) useCanvasStore.getState().openEdgeDrawer(targetFromMember(m, target.lineId))
  }, [byId, target.lineId])
  const locateOne = useCallback((id: string) => {
    const m = byId.get(id)
    if (m) void onLocateMany?.([m.source, m.target])
  }, [byId, onLocateMany])
  // On the server: every one of them, however many — as their entity ids where they were read.
  const onServer = useCallback(() => usePropertyJobsStore.getState().requestOp({
    target: { kind: 'relationships', ids: target.members.map((m) => read.records.get(m.id)?.entityId ?? m.id) },
  }), [target.members, read.records])

  const [listOpen, setListOpen] = useState(false)
  const [leftOutOpen, setLeftOutOpen] = useState(false)
  const leftOut = useMemo(() => {
    const by = new Map<string, number>()
    for (const e of excluded) by.set(e.reason, (by.get(e.reason) ?? 0) + 1)
    return [...by]
  }, [excluded])

  const blockedNote = !editable && editOffered && !read.isLoading
    ? tooMany
      ? `Up to ${MULTI_RELATIONSHIP_MAX.toLocaleString()} relationships are compared and edited here; these ${target.members.length.toLocaleString()} are changed on the server instead.`
      : !read.versioned ? NO_VERSION_CONTROL
        : held.length === 0 ? null
          : editing.blocked ?? (canEdit ? null : VIEW_ONLY_DRAFT)
    : null

  return (
    <DrawerShell
      titleId={titleId}
      focusKey={target.id}
      dirty={dirty}
      dirtyWhat={<>your changes to <span className="font-semibold text-ink">{held.length.toLocaleString()} relationships</span></>}
      onClose={onClose}
      onStage={stage}
      canStage={dirty && !!preview && preview.entities > 0}
      onDiscard={discard}
    >
      <DrawerHeader className="bg-gradient-to-br from-accent-lineage/[0.07] to-transparent">
        <DrawerTopBar badge={<Badge tone="accent" size="md" caps>Relationships</Badge>}
          closeLabel="Close relationship details" onClose={onClose} />
        <h2 id={titleId} tabIndex={-1} className="text-xl font-display font-semibold leading-tight text-ink outline-none">
          {target.members.length.toLocaleString()} relationships
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {editable ? 'What they share, and where they differ — change it for all at once.' : 'What they share, and where they differ.'}
        </p>
        {types.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {types.map(([t, n]) => (
              <span key={t} className="inline-flex items-center gap-1">
                <TypeChip type={t} label={relationshipCopy(t, relationshipTypes).label} />
                <span className="text-xs tabular-nums text-ink-muted">{n.toLocaleString()}</span>
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onLocateMany && (
            <Button size="sm" variant="subtle" leftIcon={Crosshair} onClick={() => { void onLocateMany(ends) }}>Locate all ends</Button>
          )}
          <Button size="sm" variant="subtle" leftIcon={Waypoints} onClick={() => useCanvasStore.getState().requestDrawerMove(() => {
            const onCanvas = useCanvasStore.getState()._edgeIndex
            openInEdgeExplorer(target.members.filter((m) => onCanvas.has(m.id)).map((m) => m.id))
          })}>
            Edge Explorer
          </Button>
          {editOffered && (
            <Button size="sm" variant="subtle" leftIcon={Database} onClick={onServer}>Change on the server…</Button>
          )}
        </div>
        {heldIds.length > 0 && (
          <>
            <button type="button" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}
              className="mt-3 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
              {listOpen ? 'Hide' : 'List'} the {heldIds.length.toLocaleString()} compared
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', listOpen && 'rotate-180')} aria-hidden />
            </button>
            {listOpen && (
              <div className="mt-2 max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border bg-canvas">
                <MemberList ids={heldIds} memberOf={memberOf} className="ml-0 my-1"
                  onFocusNode={onLocateMany ? locateOne : undefined} onOpenNode={openOne} />
              </div>
            )}
          </>
        )}
      </DrawerHeader>

      <DrawerBody>
        {(blockedNote || excluded.length > 0 || read.isError) && (
          <div className="mx-5 mt-4 space-y-2">
            {read.isError && (
              <Notice tone="warn" action={{ label: 'Retry', onClick: read.refetch }}>Couldn’t read these relationships.</Notice>
            )}
            {blockedNote && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <div className="min-w-0 flex-1 text-xs leading-snug text-ink">
                  {blockedNote}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tooMany && <Button size="sm" variant="secondary" leftIcon={Database} onClick={onServer}>Change all {target.members.length.toLocaleString()} on the server</Button>}
                    {!tooMany && onStartEditing && editing.blocked && editing.blocked !== NO_VERSION_CONTROL && (
                      <Button size="sm" variant="secondary" onClick={onStartEditing}>Edit in a draft</Button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {excluded.length > 0 && (
              <div className="rounded-xl border border-glass-border p-3 text-xs text-ink-secondary">
                <button type="button" onClick={() => setLeftOutOpen((o) => !o)} aria-expanded={leftOutOpen}
                  className="flex w-full items-center gap-1.5 text-left font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded-md">
                  {excluded.length.toLocaleString()} left out
                  <span className="min-w-0 flex-1 truncate font-normal text-ink-muted">
                    {leftOut.map(([reason, n]) => `${n.toLocaleString()} · ${reason}`).join(' — ')}
                  </span>
                  <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', leftOutOpen && 'rotate-180')} aria-hidden />
                </button>
                {leftOutOpen && (
                  <ul className="mt-2 max-h-48 overflow-y-auto custom-scrollbar space-y-1" aria-label="Relationships left out">
                    {excluded.map(({ member, reason }) => (
                      <li key={member.id} className="flex items-center gap-2">
                        <button type="button" onClick={() => openOne(member.id)}
                          className="min-w-0 flex-1 truncate text-left text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded">
                          {nameOf(member)}
                        </button>
                        <span className="shrink-0 text-ink-muted">{reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {read.isLoading ? (
          <div className="p-5"><SkeletonText lines={4} /></div>
        ) : held.length > 0 ? (
          <MultiProperties
            fields={fields.properties}
            nodeIds={heldIds}
            edit={edit}
            onChange={onChange}
            onAddAll={onAddAll}
            editable={editable}
            sharedValueRefused={NOT_REFUSED}
            memberOf={memberOf}
            onFocusNode={onLocateMany ? locateOne : undefined}
            onOpenNode={openOne}
            staged={staged}
            suggestions={NO_SUGGESTIONS}
          />
        ) : !read.isError && (
          <p className="px-5 py-4 text-xs text-ink-muted">None of these can be compared here.</p>
        )}
      </DrawerBody>

      {editable && (
        <DrawerFooter className="flex items-center gap-2">
          <span aria-live="polite" className="min-w-0 flex-1 text-[11.5px] text-ink-muted">
            {!preview ? 'Nothing changed yet.' : <FooterSummary preview={preview} />}
          </span>
          {dirty && <Button size="sm" variant="ghost" onClick={discard}>Discard</Button>}
          <Button size="sm" variant="primary" disabled={!dirty || !preview || preview.entities === 0} onClick={stage}>
            Stage for {(preview?.entities || held.length).toLocaleString()}
          </Button>
        </DrawerFooter>
      )}
    </DrawerShell>
  )
}

function FooterSummary({ preview }: { preview: ReturnType<typeof previewBulkEdit> }) {
  if (preview.entities === 0) {
    return <>Nothing would change{preview.skipped > 0 ? ` · ${preview.skipped.toLocaleString()} left as they are` : ' — they hold this already'}.</>
  }
  const parts = [
    `${preview.changes.toLocaleString()} ${preview.changes === 1 ? 'change' : 'changes'}`,
    `${preview.entities.toLocaleString()} ${preview.entities === 1 ? 'relationship' : 'relationships'}`,
  ]
  if (preview.overwritten > 0) parts.push(`${preview.overwritten.toLocaleString()} replaced`)
  if (preview.skipped > 0) parts.push(`${preview.skipped.toLocaleString()} left as they are`)
  return <>{parts.join(' · ')}</>
}
