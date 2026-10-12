/**
 * The entity drawer's View tab — calm and read-only: its identifier, descriptive details, where it
 * sits, its properties, classifications, lineage and history.
 */
import { Check, Copy, FileText, History, Info, Link, Tag } from 'lucide-react'
import { useFeature } from '@/store/features'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import type { RevealSearchHit } from '@/hooks/useRevealSearchHit'
import { IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Section } from '../DrawerSection'
import { PropertyEditor } from '../PropertyEditor'
import { PanelErrorBoundary } from '../PanelErrorBoundary'
import { LineageNeighbors } from '../LineageNeighbors'
import { PlacementSummary } from './EntityPlacement'

type Data = Record<string, unknown>

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
  nodeId, form, urn, childCount, tagColors, userProps, copiedUrn, onCopyUrn, canEdit, onStartEdit,
  onFocusNode, onLocateMany, onRevealPath, history,
}: {
  nodeId: string
  form: Data
  urn: string
  childCount: number
  tagColors: { bg: string; text: string }
  userProps: Data
  copiedUrn: boolean
  onCopyUrn: () => void
  /** Offer "Add properties" when there are none and the drawer can edit. */
  canEdit: boolean
  onStartEdit: () => void
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  onRevealPath?: RevealSearchHit
  history: { wsId?: string; graphId?: string | null; mainBranchId?: string | null; branchId?: string | null }
}) {
  const versioningEnabled = useFeature('versioningEnabled')
  const hasProps = Object.keys(userProps).length > 0
  const tags = Array.isArray(form.classifications) ? (form.classifications as string[]) : []

  return (
    <div className="divide-y divide-glass-border">
      <Section title="Identifier" icon={Link}>
        <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
          <code className="flex-1 text-xs font-mono text-ink-muted truncate" title={urn}>{urn}</code>
          <IconButton icon={copiedUrn ? Check : Copy} label={copiedUrn ? 'Copied' : 'Copy URN'} size="sm" onClick={onCopyUrn}
            className={copiedUrn ? 'text-emerald-600 dark:text-emerald-400' : undefined} />
        </div>
      </Section>

      <DetailsList form={form} />

      <PlacementSummary nodeId={nodeId} childCount={childCount} onFocusNode={onFocusNode} />

      <Section title="Properties" icon={FileText} flush={hasProps}>
        {hasProps ? (
          <PanelErrorBoundary resetKeys={[urn]}>
            <PropertyEditor value={userProps} onChange={() => {}} readOnly searchable groupByPath bare />
          </PanelErrorBoundary>
        ) : (
          <EmptyState compact icon={FileText} title="No properties yet"
            description={canEdit ? 'Add owners, SLAs, tags — anything worth knowing about it.' : undefined}
            action={canEdit ? { label: 'Add properties', onClick: onStartEdit } : undefined} />
        )}
      </Section>

      {tags.length > 0 && (
        <Section title="Classifications" icon={Tag}>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span key={tag} className="px-2.5 py-1 rounded-lg text-xs font-medium" style={{ backgroundColor: tagColors.bg, color: tagColors.text }}>
                {tag}
              </span>
            ))}
          </div>
        </Section>
      )}

      <LineageNeighbors nodeId={nodeId} onFocusNode={onFocusNode} onLocateMany={onLocateMany} onRevealPath={onRevealPath} />

      {versioningEnabled && history.wsId && history.graphId && (
        <Section title="History" icon={History}>
          <EntityHistory wsId={history.wsId} graphId={history.graphId} entityId={nodeId}
            mainBranchId={history.mainBranchId} branchId={history.branchId} kind="node" />
        </Section>
      )}
    </div>
  )
}
