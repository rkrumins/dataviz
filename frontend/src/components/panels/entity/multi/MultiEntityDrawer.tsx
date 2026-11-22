/**
 * MultiEntityDrawer — several entities, read and edited as one, in the entity drawer.
 *
 * Opened on a selection (the selection bar's "Edit N…", Property Manager's "Compare & edit"), it
 * holds the entities it was opened on: clicking around the canvas never changes what an edit here
 * would touch — when the selection moves on, the header offers to compare that instead.
 *
 * - **Reading.** Each property is Same on all of them, Differs, or held by only some; opening a
 *   row shows every value and who holds it. Entities are named as people find them; a list opened
 *   on them adds each one's ID beneath (its data source's identity property, else its URN), in
 *   either view.
 * - **Editing**, in a draft: set a value for all, fill where missing, rename, copy, remove from
 *   all, add a property to all — each change pending until "Stage", then staged as each entity's
 *   own edit in one step that Undo takes back. Unstaged changes hold every move of the drawer
 *   (`DrawerShell`), like the single drawer's do. Outside a draft, "Edit in a draft" sits in the
 *   top line; a note says why it can't be edited here only when its tip can't.
 * - **Scale.** Read once per change of the entities (`sharedFields`, one pass); the drawer never
 *   re-renders for writes to other entities; long lists paint only what is on screen. Up to
 *   `MULTI_EDIT_MAX` entities are edited here — more are compared, and changed from Property
 *   Manager, which does it on the server.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AlertCircle, AlignLeft, RotateCcw } from 'lucide-react'
import { useCanvasStore, isSelectableNode, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePersonaStore } from '@/store/persona'
import { nodeIndexOf } from '@/lib/storeIndex'
import { resolveEntityName, technicalIdentity } from '@/lib/entityDisplayName'
import { useCanvasIdentityProperty } from '@/components/dataSource/NodeIdentity'
import { governedFields } from '@/lib/fieldRules'
import { NO_DRAFT, NO_VERSION_CONTROL, VIEW_ONLY_DRAFT, useEntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import { useAppNotifications } from '@/components/ui/notifications'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import {
  bulkEditSize, isEmptyBulkEdit, previewBulkEdit, sharedFields, stageBulkEdit, type BulkEdit, type SharedField,
} from '@/components/canvas/context-view/bulkEdit'
import { DrawerBody, DrawerFooter, DrawerShell } from '../../shell/DrawerShell'
import { EditInDraftButton } from '../../shell/DrawerTopBar'
import { Section } from '../../DrawerSection'
import { InlineValue } from '../../property/InlineValue'
import { RichValue } from '../../property/RichValue'
import { peerPropertyStats } from '../peerPropertyStats'
import { Distribution, type GovernedRule } from './ComparisonRow'
import { EMPTY_EDIT, withChange, type KeyChange } from './editOps'
import { MultiEntityHeader, type TypeCount } from './MultiEntityHeader'
import { MultiProperties } from './MultiProperties'
import type { Member } from './ValueBreakdown'

/** Entities edited here at once; more are compared, and changed from Property Manager. */
export const MULTI_EDIT_MAX = 10_000

const STAGED_MARK_MS = 2500

export function MultiEntityDrawer({
  ids, canEdit = false, onStartEditing, writesLocked = false, onFocusNode, onLocateMany,
}: {
  /** The entities it was opened on. */
  ids: readonly string[]
  canEdit?: boolean
  onStartEditing?: () => void
  writesLocked?: boolean
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
}) {
  // Each entity as the store holds it — the SAME objects until one of them changes, so writes to
  // other entities never re-render this.
  const members = useCanvasStore(useShallow((s) => {
    const index = nodeIndexOf(s.nodes)
    return ids.map((id) => index.get(id) ?? null)
  }))
  const held = useMemo(() => members.filter((n): n is LineageNode => !!n), [members])
  const heldIds = useMemo(() => held.map((n) => n.id), [held])
  const goneIds = useMemo(() => ids.filter((_, i) => !members[i]), [ids, members])
  const fields = useMemo(() => sharedFields(held as ReadonlyArray<{ id: string; data: Record<string, unknown> }>), [held])

  const personaMode = usePersonaStore((s) => s.mode)
  const entityTypes = useSchemaStore((s) => s.schema?.entityTypes)
  const byId = useMemo(() => new Map(held.map((n) => [n.id, n])), [held])
  const identityProperty = useCanvasIdentityProperty()
  const memberOf = useCallback((id: string): Member => {
    const n = byId.get(id)
    if (!n) return { id, name: 'Not loaded', ident: id, notLoaded: true }
    const name = resolveEntityName(n.data, personaMode, id)
    // Its ID in either view — detail a list opened on it shows, left out where it is the name.
    const ident = technicalIdentity(n.data, 'technical', { identityProperty, urn: id, name })?.value
    return { id, name, ident, type: String((n.data as Record<string, unknown>).type ?? '') }
  }, [byId, personaMode, identityProperty])

  // How many of each type — the selection in the reader's words — and what no two of a type may share.
  const { types, refusals } = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of held) {
      const t = String((n.data as Record<string, unknown>).type ?? '')
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const refusals = new Map<string, string>()
    const types: TypeCount[] = [...counts.entries()].map(([id, count]) => {
      const type = entityTypes?.find((e) => e.id === id)
      const plural = type?.pluralName ?? `${type?.name ?? id}s`
      if (count > 1) {
        for (const f of type?.fields ?? []) {
          if (f.unique && !refusals.has(f.id)) refusals.set(f.id, `No two ${plural} may share a ${f.name || f.id} — set it one at a time.`)
        }
      }
      return { id, count, label: count === 1 ? (type?.name ?? id) : plural, color: type?.visual?.color ?? '#6366f1' }
    }).sort((a, b) => b.count - a.count)
    return { types, refusals }
  }, [held, entityTypes])
  const sharedValueRefused = useCallback((key: string) => refusals.get(key) ?? null, [refusals])
  // The fields a publish judges, by key — the most-selected type's, where two types define one.
  // Their rows offer the allowed values and warn (never block) of a change publishing would refuse.
  // Kept while the types held stay the same, so a write to one of them re-renders no row for it.
  const typeOrder = types.map((t) => t.id).join('\u0000')
  const rules = useMemo(() => {
    const out = new Map<string, GovernedRule>()
    for (const id of typeOrder ? typeOrder.split('\u0000') : []) {
      const type = entityTypes?.find((e) => e.id === id)
      for (const [key, field] of governedFields(type?.fields)) {
        if (!out.has(key)) out.set(key, { field, typeLabel: type?.pluralName ?? `${type?.name ?? id}s`, typeId: id, typeName: type?.name ?? id })
      }
    }
    return out
  }, [typeOrder, entityTypes])
  const fieldRuleFor = useCallback((key: string) => rules.get(key) ?? null, [rules])
  const suggestions = useCallback(() => peerPropertyStats('', types[0]?.id ?? ''), [types])

  // The canvas selection, when it has moved on from what is compared.
  const idSet = useMemo(() => new Set(ids), [ids])
  const selectionNow = useCanvasStore((s) => {
    const sel = s.selectedNodeIds
    if (sel.length < 2) return 0
    const selectable = sel.filter(isSelectableNode)
    const same = selectable.length === idSet.size && selectable.every((id) => idSet.has(id))
    return same ? 0 : selectable.length
  })

  // ── Whether it can be edited here ──
  const editing = useEntityEditing()
  const editOffered = !writesLocked && editing.offered
  const tooMany = held.length > MULTI_EDIT_MAX
  const editable = canEdit && editOffered && !editing.blocked && !tooMany

  // ── The edit: one pending change per property, kept until staged — for the entities opened on ──
  const [edit, setEdit] = useState<BulkEdit>(EMPTY_EDIT)
  const [editFor, setEditFor] = useState(ids)
  if (editFor !== ids) {
    setEditFor(ids)
    setEdit(EMPTY_EDIT)
  }
  const dirty = editable && !isEmptyBulkEdit(edit)
  const onChange = useCallback((key: string, change: KeyChange | null) => setEdit((e) => withChange(e, key, change)), [])
  const onAddAll = useCallback((entries: Array<[string, unknown]>) =>
    setEdit((e) => entries.reduce((acc, [k, value]) => withChange(acc, k, { kind: 'set', value }), e)), [])
  const setDescription = useCallback((description: string | undefined) => setEdit((e) => ({ ...e, description })), [])
  const preview = useMemo(() => (dirty ? previewBulkEdit(held, edit) : null), [dirty, held, edit])

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
    const undo = stageBulkEdit(held, edit)
    const size = bulkEditSize(edit)
    notify('success',
      `Staged ${size.toLocaleString()} ${size === 1 ? 'change' : 'changes'} on ${preview.entities.toLocaleString()} ${preview.entities === 1 ? 'entity' : 'entities'} — Review & Save keeps them.`,
      { label: 'Undo', onClick: undo })
    setEdit(EMPTY_EDIT)
    setStaged(touched)
  }, [dirty, preview, edit, held, notify])
  const discard = useCallback(() => setEdit(EMPTY_EDIT), [])

  const close = useCallback(() => useCanvasStore.getState().requestDrawerMove(() => {
    const s = useCanvasStore.getState()
    s.closeNodeDrawer()
    s.clearSelection()
  }), [])
  const openNode = useCallback((id: string) => useCanvasStore.getState().openNodeDrawer(id), [])
  const compareSelection = useCallback(() => {
    const s = useCanvasStore.getState()
    s.openNodesDrawer(s.selectedNodeIds)
  }, [])
  const focusNode = useCallback((id: string) => { void onFocusNode?.(id) }, [onFocusNode])

  const titleId = useId()
  const blockedNote = !editable && editOffered
    ? tooMany
      ? `Up to ${MULTI_EDIT_MAX.toLocaleString()} entities are edited here at once. Select fewer — or change them all from Property Manager.`
      : editing.blocked ?? (canEdit ? null : VIEW_ONLY_DRAFT)
    : null
  const offerDraft = !!blockedNote && !!onStartEditing && !tooMany && editing.blocked !== NO_VERSION_CONTROL
  // "Switch to a draft" is the button's tip; the note is for what the tip doesn't cover.
  const note = offerDraft && blockedNote === NO_DRAFT ? null : blockedNote

  return (
    <DrawerShell
      titleId={titleId}
      focusKey={`nodes:${ids.length}:${ids[0] ?? ''}`}
      dirty={dirty}
      dirtyWhat={<>your changes to <span className="font-semibold text-ink">{held.length.toLocaleString()} entities</span></>}
      onClose={close}
      onStage={stage}
      canStage={dirty && !!preview && preview.entities > 0}
      onDiscard={discard}
    >
      <MultiEntityHeader
        titleId={titleId}
        ids={heldIds}
        types={types}
        memberOf={memberOf}
        gone={goneIds}
        editable={editable}
        action={offerDraft ? <EditInDraftButton onClick={onStartEditing} reason={blockedNote} /> : undefined}
        selectionNow={selectionNow}
        onUseSelection={compareSelection}
        onClose={close}
        onFocusNode={onFocusNode}
        onOpenNode={openNode}
        onLocateAll={onLocateMany ? () => void onLocateMany(heldIds) : undefined}
      />

      <DrawerBody>
        {note && (
          <p className="mx-5 mt-3 flex items-start gap-2 rounded-lg bg-amber-500/[0.07] px-3 py-1.5 text-xs leading-snug text-amber-800 dark:text-amber-200">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            {note}
          </p>
        )}

        <DescriptionSection field={fields.description} value={edit.description} editable={editable} onChange={setDescription} />

        <MultiProperties
          fields={fields.properties}
          nodeIds={heldIds}
          edit={edit}
          onChange={onChange}
          onAddAll={onAddAll}
          editable={editable}
          sharedValueRefused={sharedValueRefused}
          fieldRuleFor={fieldRuleFor}
          memberOf={memberOf}
          onFocusNode={onFocusNode ? focusNode : undefined}
          onOpenNode={openNode}
          staged={staged}
          suggestions={suggestions}
        />
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
    `${preview.entities.toLocaleString()} ${preview.entities === 1 ? 'entity' : 'entities'}`,
  ]
  if (preview.overwritten > 0) parts.push(`${preview.overwritten.toLocaleString()} replaced`)
  if (preview.skipped > 0) parts.push(`${preview.skipped.toLocaleString()} left as they are`)
  return <>{parts.join(' · ')}</>
}

/** The description: the same on all, differing, or missing on some — and one typed for all. */
function DescriptionSection({ field, value, editable, onChange }: {
  field: SharedField
  value: string | undefined
  editable: boolean
  onChange: (description: string | undefined) => void
}) {
  const summary = value !== undefined
    ? <span className="inline-flex items-center gap-1.5 min-w-0"><RichValue value={value} fieldKey="description" /><span className="text-2xs text-ink-muted shrink-0">for all</span></span>
    : field.kind === 'same' ? <RichValue value={field.value} fieldKey="description" />
      : field.has === 0 ? <span className="text-xs text-ink-muted">None of them has one.</span>
        : <Distribution field={field} />
  return (
    <Section
      title="Description"
      icon={AlignLeft}
      action={
        <span className="flex items-center gap-1">
          {field.has > 0 && (field.kind === 'same' ? <Badge tone="success" size="md">Same</Badge>
            : field.kind === 'differs' ? <Badge tone="warning" size="md">Differs</Badge>
              : <Badge size="md">On {field.has.toLocaleString()} of {field.total.toLocaleString()}</Badge>)}
          {value !== undefined && (
            <IconButton icon={RotateCcw} label="Leave each description as it is" size="sm" className="w-6 h-6" onClick={() => onChange(undefined)} />
          )}
        </span>
      }
    >
      {editable ? (
        <InlineValue
          value={value ?? (field.kind === 'same' ? field.value : undefined)}
          fieldType="text"
          fieldLabel="Description for all"
          onCommit={(next) => onChange(typeof next === 'string' ? next : String(next ?? ''))}
          readView={summary}
        />
      ) : summary}
    </Section>
  )
}
