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
import { Check, Copy, FileText, History, Info, Link, Sparkles, Tag } from 'lucide-react'
import { useFeature } from '@/store/features'
import { useCanvasStore } from '@/store/canvas'
import { userProperties } from '@/lib/nodeFields'
import { inferFieldType, type FieldType } from '../property/fieldTypes'
import type { PropertySuggestion } from '../property/composerModel'
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
import { defaultFeatured, featurableKeys, propertyLabel, resolveFeatured, resolveLayout, shownSections } from './drawerLayout'

type Data = Record<string, unknown>

/** Entities read before the suggestions give up: enough to see what a type usually carries. */
const SUGGEST_SCAN = 2000

/** What other loaded entities of this type carry, property by property — how many, a couple of
 *  example values, and the type its values usually are — for those at least two carry, most common
 *  first. Read once from the canvas as it is when the drawer opens on the entity, never subscribed to. */
function peerPropertyStats(nodeId: string, typeId: string): PropertySuggestion[] {
  if (!typeId) return []
  const stats = new Map<string, { count: number; examples: string[]; types: Map<FieldType, number> }>()
  let scanned = 0
  for (const n of useCanvasStore.getState().nodes) {
    const d = n.data as Data
    if (n.id === nodeId || d.type !== typeId) continue
    if (++scanned > SUGGEST_SCAN) break
    for (const [k, v] of Object.entries(userProperties(d.properties))) {
      let st = stats.get(k)
      if (!st) stats.set(k, (st = { count: 0, examples: [], types: new Map() }))
      st.count++
      const t = inferFieldType(v)
      st.types.set(t, (st.types.get(t) ?? 0) + 1)
      const ex = typeof v === 'string' || typeof v === 'number' ? String(v) : null
      if (ex && ex.length <= 40 && st.examples.length < 2 && !st.examples.includes(ex)) st.examples.push(ex)
    }
  }
  return [...stats].filter(([, st]) => st.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 24)
    .map(([key, st]) => ({ key, count: st.count, examples: st.examples, type: [...st.types].sort((a, b) => b[1] - a[1])[0]?.[0] }))
}

const without = (o: Data, keys: readonly string[]): Data =>
  keys.length === 0 ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

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
  originalProps, publishedProps, digest, onCommitProperties,
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
  /** In a draft, the properties as published: what the draft changed, saved or not yet. */
  publishedProps?: Data
  /** What the draft has done to it, at the top. */
  digest?: ReactNode
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
  const suggestions = useMemo(() => (editsProps ? peerPropertyStats(nodeId, typeId) : []), [editsProps, nodeId, typeId])
  // A property removed is still listed (struck through, with Restore while editing).
  const removedSome = [originalProps, publishedProps].some((base) => !!base && Object.keys(base).some((k) => !(k in userProps)))

  // Shown at a glance: marked in the list, and — read-only — left out of it (one unchanged by the
  // draft, that is: a change is still seen where it is listed). Featured from a row too.
  const glanceShown = sections.includes('overview')
  const pinned = usePreferencesStore((s) => s.drawerPinnedProperties[typeId])
  const setPinned = usePreferencesStore((s) => s.setDrawerPinnedProperties)
  const featuredKeys = useMemo(
    () => (glanceShown ? resolveFeatured(pinned, fields, form).map((f) => f.key).filter((k) => k in userProps) : []),
    [glanceShown, pinned, fields, form, userProps],
  )
  const toggleFeatured = (key: string) => {
    const keys = featurableKeys(fields, form, userProps)
    const current = pinned ?? defaultFeatured(fields).filter((k) => keys.includes(k))
    setPinned(typeId, current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
  }
  const atGlance = useMemo(() => (editsProps ? [] : featuredKeys.filter((k) =>
    !publishedProps || (k in publishedProps && JSON.stringify(publishedProps[k]) === JSON.stringify(userProps[k])))),
  [editsProps, featuredKeys, publishedProps, userProps])
  const listedProps = useMemo(() => without(userProps, atGlance), [userProps, atGlance])
  const listedPublished = useMemo(() => publishedProps && without(publishedProps, atGlance), [publishedProps, atGlance])
  const glanceId = `glance-${nodeId}`

  const render: Record<DrawerSectionId, () => ReactNode> = {
    overview: () => (
      <div id={glanceId}>
        <EntityOverview form={form} urn={urn} identity={identity} childCount={childCount} typeId={typeId} fields={fields} />
      </div>
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
      <Section title="Properties" icon={FileText} flush={hasProps || removedSome || (editsProps && adding)}>
        {hasProps || removedSome || (editsProps && adding) ? (
          <PanelErrorBoundary resetKeys={[urn]}>
            {editsProps ? (
              <PropertyEditor key={nodeId} value={userProps} onChange={(next) => onCommitProperties!(next as Data)}
                inline original={originalProps} published={publishedProps} startAdding={adding && !hasProps} suggestions={suggestions}
                searchable groupByPath bare sectionsKey={typeId ? `entity:${typeId}` : undefined}
                featuredKeys={featuredKeys} onToggleFeatured={glanceShown && typeId ? toggleFeatured : undefined} />
            ) : Object.keys(listedProps).length > 0 || removedSome ? (
              <PropertyEditor value={listedProps} onChange={() => {}} readOnly published={listedPublished} searchable groupByPath bare
                sectionsKey={typeId ? `entity:${typeId}` : undefined}
                featuredKeys={featuredKeys} onToggleFeatured={glanceShown && typeId ? toggleFeatured : undefined} />
            ) : null}
            {atGlance.length > 0 && (
              <button type="button" onClick={() => document.getElementById(glanceId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
                className="mt-2 inline-flex items-center gap-1.5 text-2xs text-ink-muted hover:text-accent-lineage transition-colors">
                <Sparkles aria-hidden className="w-3 h-3" />
                {atGlance.map((k) => propertyLabel(k, fields)).join(', ')} — shown at a glance
              </button>
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
      {digest}
      <div className="divide-y divide-glass-border">
        {sections.map((id) => <Fragment key={id}>{render[id]()}</Fragment>)}
      </div>
    </>
  )
}
