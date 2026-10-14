/**
 * Versioning — a menu like the other filters, narrowing the list to views whose
 * graph is versioned here, or kept by another system.
 *
 * The words, icons and tones are the ones the sync-status chip already uses for the
 * same distinction, so a person who learns "Versioned" here has learnt it
 * everywhere. Picking the chosen kind again lets go of the filter.
 *
 * Hidden when version control is switched off for the deployment: every
 * version-control surface goes with it.
 */
import { GitBranch } from 'lucide-react'
import { useFeature } from '@/store/features'
import { FilterDropdown, type FilterOption } from '@/components/explorer/FilterDropdown'
import type { SourceKind } from '../model'
import { SOURCE_KIND_LABELS } from '../dimensions'
import { SOURCE_KIND_META } from '../sourceKindMeta'

const KINDS = ['versioned', 'external'] as const

/** One line under each option: what the kind means for a view. */
const HINT: Record<SourceKind, string> = {
  versioned: 'Changed through drafts and review',
  external: 'Kept by another system',
}

export function SourceKindMenu({ value, onChange, counts, countsPending }: {
  value: SourceKind | null
  onChange: (next: SourceKind | null) => void
  /** Views each kind would leave, given the other filters. */
  counts?: Partial<Record<SourceKind, number>> | null
  countsPending?: boolean
}) {
  const enabled = useFeature('versioningEnabled')
  if (!enabled) return null

  const options: FilterOption[] = KINDS.map(kind => ({
    id: kind,
    label: SOURCE_KIND_LABELS[kind],
    sublabel: HINT[kind],
    icon: SOURCE_KIND_META[kind].icon,
    iconClassName: SOURCE_KIND_META[kind].glyph,
    count: counts?.[kind],
  }))

  return (
    <FilterDropdown
      icon={value ? SOURCE_KIND_META[value].icon : GitBranch}
      label="Versioning"
      accent={value === 'external' ? 'sky' : 'violet'}
      selectionMode="single"
      options={options}
      selectedIds={value ? [value] : []}
      onChange={ids => onChange((ids[0] as SourceKind | undefined) ?? null)}
      activeLabelFormatter={ids => SOURCE_KIND_LABELS[ids[0] as SourceKind]}
      countsPending={countsPending}
      disableSearch
      panelWidthClassName="w-64"
    />
  )
}
