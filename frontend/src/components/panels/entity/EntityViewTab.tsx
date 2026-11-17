/**
 * The entity drawer's View tab — the entity at a glance, its identifier, descriptive details,
 * where it sits, its properties, classifications, lineage and history. In a draft its properties
 * are edited in place: click a value, type, Enter — the edit is staged as it is made, and each row
 * says what changed.
 *
 * Which sections show, and in what order, is the view's (drawerLayout.ts): every one in the
 * Technical view, in the order it always had; the entity at a glance first in the Business view,
 * with the identifier block, the raw details, placement and history switched off. Either can be
 * changed from Customize, which opens above the sections.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, FileText, History, Info, Link, Tag } from 'lucide-react'
import { useFeature } from '@/store/features'
import { useCanvasStore } from '@/store/canvas'
import { userProperties } from '@/lib/nodeFields'
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore, type DrawerSectionId } from '@/store/preferences'
import type { EntityFieldDefinition } from '@/types/schema'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import type { RevealSearchHit } from '@/hooks/useRevealSearchHit'
import { IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Section } from '../DrawerSection'
import { PropertyEditor } from '../PropertyEditor'
import { PanelErrorBoundary } from '../PanelErrorBoundary'
import { LineageNeighbors } from '../LineageNeighbors'
import { PlacementSummary } from './EntityPlacement'
import { NodeIdentityFacts } from '@/components/dataSource/NodeIdentity'
import { EntityOverview } from './EntityOverview'
import { CustomizeDetails } from './CustomizeDetails'
import { featurableKeys, resolveLayout, shownSections } from './drawerLayout'

type Data = Record<string, unknown>

/** Entities read before the suggestions give up: enough to see what a type usually carries. */
const SUGGEST_SCAN = 2000

/** Property names at least two other loaded entities of this type carry, most common first — read
 *  once from the canvas as it is when the drawer opens on the entity, never subscribed to. */
function suggestedPropertyKeys(nodeId: string, typeId: string): string[] {
  if (!typeId) return []
  const counts = new Map<string, number>()
  let scanned = 0
  for (const n of useCanvasStore.getState().nodes) {
    const d = n.data as Data
    if (n.id === nodeId || d.type !== typeId) continue
    if (++scanned > SUGGEST_SCAN) break
    for (const k of Object.keys(userProperties(d.properties))) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
}

/** The descriptive node fields, when any has a value. */
function DetailsList({ form }: { form: Data }) {
  const rows = ([
    ['qualifiedName', 'Qualified name'],
    ['description', 'Description'],
    ['sourceSystem', 'Source system'],
    ['layerAssignment', 'Layer'],
    ['lastSyncedAt', 'Last synced'],
  ] as const).filter(([k]) => form[k] !== undefined && form[k] !== null && form[k] !== '')
  if (rows.length === 0) return null
  return (
    <Section title="Details" icon={Info}>
      <dl className="space-y-1">
        {rows.map(([key, label]) => (
          <div key={key} className="flex items-start justify-between gap-4 py-1.5">
            <dt className="text-xs text-ink-muted min-w-[110px]">{label}</dt>
            <dd className="text-xs text-ink text-right break-words min-w-0">{String(form[key])}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

export function EntityViewTab({
  nodeId, form, original, urn, childCount, tagColors, userProps, copiedUrn, onCopyUrn, canEdit,
  originalProps, onCommitProperties,
  onFocusNode, onLocateMany, onRevealPath, history, typeId = '', typeName = '', fields, identity,
  customizing = false, onDoneCustomizing,
}: {
  nodeId: string
  form: Data
  /** The entity as stored, when `form` holds edits not saved yet — the details then say what saving
   *  stores — or null for one not saved at all. Absent: `form` is what is stored. */
  original?: Data | null
  urn: string
  childCount: number
  tagColors: { bg: string; text: string }
  userProps: Data
  copiedUrn: boolean
  onCopyUrn: () => void
  /** The properties are edited in place (a draft, in edit mode). */
  canEdit: boolean
  /** The properties as first read — what each row's edit is told against. */
  originalProps?: Data
  /** Stage the properties as edited. */
  onCommitProperties?: (bag: Data) => void
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  onRevealPath?: RevealSearchHit
  history: { wsId?: string; graphId?: string | null; mainBranchId?: string | null; branchId?: string | null }
  /** The entity's type, for what it features at a glance. */
  typeId?: string
  typeName?: string
  fields?: readonly EntityFieldDefinition[]
  /** Its identifier, shown at a glance. */
  identity?: { property: string; value: string }
  /** The Customize panel is open above the sections. */
  customizing?: boolean
  onDoneCustomizing?: () => void
}) {
  const versioningEnabled = useFeature('versioningEnabled')
  const mode = usePersonaMode()
  const storedLayout = usePreferencesStore((s) => s.drawerLayout?.[mode] ?? null)
  const sections = useMemo(() => shownSections(resolveLayout(storedLayout, mode)), [storedLayout, mode])
  const hasProps = Object.keys(userProps).length > 0
  const tags = Array.isArray(form.classifications) ? (form.classifications as string[]) : []
  const editsProps = canEdit && !!onCommitProperties
  // "Add properties" on an empty entity opens the form in place — for this entity only.
  const [addingFor, setAddingFor] = useState<string | null>(null)
  const adding = addingFor === nodeId
  const suggestions = useMemo(() => (editsProps ? suggestedPropertyKeys(nodeId, typeId) : []), [editsProps, nodeId, typeId])
  // A property removed since it was read is still listed (struck through, with Restore).
  const removedSome = !!originalProps && Object.keys(originalProps).some((k) => !(k in userProps))

  const render: Record<DrawerSectionId, () => ReactNode> = {
    overview: () => (
      <EntityOverview form={form} urn={urn} identity={identity} childCount={childCount} typeId={typeId} fields={fields} />
    ),
    identifier: () => (
      <Section title="Identifier" icon={Link}>
        <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
          <code className="flex-1 text-xs font-mono text-ink-muted truncate" title={urn}>{urn}</code>
          <IconButton icon={copiedUrn ? Check : Copy} label={copiedUrn ? 'Copied' : 'Copy URN'} size="sm" onClick={onCopyUrn}
            className={copiedUrn ? 'text-emerald-600 dark:text-emerald-400' : undefined} />
        </div>
        <NodeIdentityFacts data={original ?? form} pending={original === null} edited={original ? form : undefined} />
      </Section>
    ),
    details: () => <DetailsList form={form} />,
    relationship: () => <PlacementSummary nodeId={nodeId} childCount={childCount} onFocusNode={onFocusNode} />,
    properties: () => (
      <Section title="Properties" icon={FileText} flush={hasProps || (editsProps && (adding || removedSome))}>
        {hasProps || (editsProps && (adding || removedSome)) ? (
          <PanelErrorBoundary resetKeys={[urn]}>
            {editsProps ? (
              <PropertyEditor key={nodeId} value={userProps} onChange={(next) => onCommitProperties!(next as Data)}
                inline original={originalProps} startAdding={adding && !hasProps} suggestions={suggestions}
                searchable groupByPath bare />
            ) : (
              <PropertyEditor value={userProps} onChange={() => {}} readOnly searchable groupByPath bare />
            )}
          </PanelErrorBoundary>
        ) : (
          <EmptyState compact icon={FileText} title="No properties yet"
            description={editsProps ? 'Add owners, SLAs, tags — anything worth knowing about it.' : undefined}
            action={editsProps ? { label: 'Add properties', onClick: () => setAddingFor(nodeId) } : undefined} />
        )}
      </Section>
    ),
    classifications: () => tags.length > 0 && (
        <Section title="Classifications" icon={Tag}>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span key={tag} className="px-2.5 py-1 rounded-lg text-xs font-medium" style={{ backgroundColor: tagColors.bg, color: tagColors.text }}>
                {tag}
              </span>
            ))}
          </div>
        </Section>
    ),
    lineage: () => (
      <LineageNeighbors nodeId={nodeId} onFocusNode={onFocusNode} onLocateMany={onLocateMany} onRevealPath={onRevealPath} />
    ),
    history: () => versioningEnabled && history.wsId && history.graphId && (
        <Section title="History" icon={History}>
          <EntityHistory wsId={history.wsId} graphId={history.graphId} entityId={nodeId}
            mainBranchId={history.mainBranchId} branchId={history.branchId} kind="node" />
        </Section>
    ),
  }

  return (
    <>
      {customizing && onDoneCustomizing && (
        <CustomizeDetails typeId={typeId} typeName={typeName || typeId || 'entity'} fields={fields}
          propertyKeys={featurableKeys(fields, form, userProps)} onDone={onDoneCustomizing} />
      )}
      <div className="divide-y divide-glass-border">
        {sections.map((id) => <Fragment key={id}>{render[id]()}</Fragment>)}
      </div>
    </>
  )
}
