/**
 * Every view filter, described once.
 *
 * The chips under the filter bar, the "remove this filter" suggestions in an empty
 * list and the names given to saved filters all have to agree on what a filter is
 * called and how to take it away again. Each reads the entry here, so a new
 * filter is described in one place instead of in each of them.
 */
import { describeRule } from './dateFilter'
import { ME, type ContributorRole, type ViewFilterState } from './model'

export type DimensionKey =
  | 'search' | 'category' | 'sourceKind' | 'created' | 'updated' | 'people'
  | 'workspace' | 'dataSource' | 'viewType' | 'tag' | 'visibility'

/** Names the chips need, resolved by the surface that renders them. */
export interface FilterLookups {
  today: string
  workspaceName: (id: string) => string | undefined
  dataSourceName: (id: string) => string | undefined
  personName: (id: string) => string | undefined
  viewTypeLabel: (type: string) => string
}

export interface FilterChip {
  key: string
  dimension: DimensionKey
  prefix: string
  value: string
  /** The state with only this chip's part removed. */
  without: (s: ViewFilterState) => ViewFilterState
  /** A person chip shows their avatar. */
  personId?: string
  /** The name the avatar's initials come from — yours on a "You" chip. */
  personName?: string
}

export interface FilterDimension {
  key: DimensionKey
  isActive: (s: ViewFilterState) => boolean
  /** The state with this whole dimension removed. */
  clear: (s: ViewFilterState) => ViewFilterState
  chips: (s: ViewFilterState, l: FilterLookups) => FilterChip[]
  /** The dimension in one line, e.g. "Tags: pii, finance". */
  summary: (s: ViewFilterState, l: FilterLookups) => string
}

export const CATEGORY_LABELS: Record<string, string> = {
  'my-views': 'My Views',
  'my-favourites': 'Favorites',
  'recently-added': 'Recent',
  'shared-with-me': 'Shared',
  'needs-attention': 'Attention',
  'deleted': 'Deleted',
}

export const VISIBILITY_LABELS: Record<string, string> = {
  enterprise: 'Enterprise',
  workspace: 'Workspace',
  private: 'Private',
}

export const SOURCE_KIND_LABELS = { versioned: 'Versioned', external: 'External' } as const

/** How a People chip introduces its person, by role. */
export const ROLE_PREFIX: Record<ContributorRole | 'any', string> = {
  any: 'Created or edited by',
  created: 'Created by',
  edited: 'Edited by',
  published: 'Data published by',
}

function personLabel(id: string, l: FilterLookups): string {
  return id === ME ? 'You' : (l.personName(id) ?? id)
}

function list(values: string[]): string {
  return values.length <= 2 ? values.join(', ') : `${values.slice(0, 2).join(', ')} +${values.length - 2}`
}

export const DIMENSIONS: readonly FilterDimension[] = [
  {
    key: 'search',
    isActive: s => s.search.trim() !== '',
    clear: s => ({ ...s, search: '' }),
    chips: () => [], // the search box shows it
    summary: s => `Search: "${s.search.trim()}"`,
  },
  {
    key: 'category',
    isActive: s => s.category !== null,
    clear: s => ({ ...s, category: null }),
    chips: () => [], // the category pills show it
    summary: s => CATEGORY_LABELS[s.category ?? ''] ?? (s.category ?? ''),
  },
  {
    key: 'sourceKind',
    isActive: s => s.sourceKind !== null,
    clear: s => ({ ...s, sourceKind: null }),
    chips: s => (s.sourceKind ? [{
      key: 'sourceKind', dimension: 'sourceKind', prefix: 'Graph',
      value: SOURCE_KIND_LABELS[s.sourceKind], without: x => ({ ...x, sourceKind: null }),
    }] : []),
    summary: s => `${SOURCE_KIND_LABELS[s.sourceKind ?? 'versioned']} graphs`,
  },
  {
    key: 'created',
    isActive: s => s.created !== null,
    clear: s => ({ ...s, created: null }),
    chips: (s, l) => (s.created ? [{
      key: 'created', dimension: 'created', prefix: 'Created',
      value: describeRule(s.created, l.today), without: x => ({ ...x, created: null }),
    }] : []),
    summary: (s, l) => `Created: ${describeRule(s.created ?? '', l.today)}`,
  },
  {
    key: 'updated',
    isActive: s => s.updated !== null,
    clear: s => ({ ...s, updated: null }),
    chips: (s, l) => (s.updated ? [{
      key: 'updated', dimension: 'updated', prefix: 'Updated',
      value: describeRule(s.updated, l.today), without: x => ({ ...x, updated: null }),
    }] : []),
    summary: (s, l) => `Updated: ${describeRule(s.updated ?? '', l.today)}`,
  },
  {
    key: 'people',
    isActive: s => s.contributorIds.length > 0,
    clear: s => ({ ...s, contributorIds: [], contributorRole: null }),
    chips: (s, l) => s.contributorIds.map(id => ({
      key: `person-${id}`, dimension: 'people' as const,
      prefix: ROLE_PREFIX[s.contributorRole ?? 'any'],
      value: personLabel(id, l),
      personId: id,
      personName: l.personName(id) ?? personLabel(id, l),
      without: (x: ViewFilterState) => {
        const rest = x.contributorIds.filter(c => c !== id)
        // The role means nothing without a person — drop it with the last one.
        return { ...x, contributorIds: rest, contributorRole: rest.length ? x.contributorRole : null }
      },
    })),
    summary: (s, l) => `${ROLE_PREFIX[s.contributorRole ?? 'any']}: ${list(s.contributorIds.map(id => personLabel(id, l)))}`,
  },
  {
    key: 'workspace',
    isActive: s => s.workspaceIds.length > 0,
    clear: s => ({ ...s, workspaceIds: [] }),
    chips: (s, l) => s.workspaceIds.map(id => ({
      key: `ws-${id}`, dimension: 'workspace' as const, prefix: 'Workspace',
      value: l.workspaceName(id) ?? id,
      without: (x: ViewFilterState) => ({ ...x, workspaceIds: x.workspaceIds.filter(w => w !== id) }),
    })),
    summary: (s, l) => `Workspace: ${list(s.workspaceIds.map(id => l.workspaceName(id) ?? id))}`,
  },
  {
    key: 'dataSource',
    isActive: s => s.dataSourceId !== null,
    clear: s => ({ ...s, dataSourceId: null }),
    chips: (s, l) => (s.dataSourceId ? [{
      key: 'ds', dimension: 'dataSource', prefix: 'Source',
      value: l.dataSourceName(s.dataSourceId) ?? s.dataSourceId,
      without: x => ({ ...x, dataSourceId: null }),
    }] : []),
    summary: (s, l) => `Source: ${l.dataSourceName(s.dataSourceId ?? '') ?? s.dataSourceId}`,
  },
  {
    key: 'viewType',
    isActive: s => s.viewTypes.length > 0,
    clear: s => ({ ...s, viewTypes: [] }),
    chips: (s, l) => s.viewTypes.map(t => ({
      key: `vt-${t}`, dimension: 'viewType' as const, prefix: 'Type', value: l.viewTypeLabel(t),
      without: (x: ViewFilterState) => ({ ...x, viewTypes: x.viewTypes.filter(v => v !== t) }),
    })),
    summary: (s, l) => `Type: ${list(s.viewTypes.map(l.viewTypeLabel))}`,
  },
  {
    key: 'tag',
    isActive: s => s.tags.length > 0,
    clear: s => ({ ...s, tags: [] }),
    chips: s => s.tags.map(t => ({
      key: `tag-${t}`, dimension: 'tag' as const, prefix: 'Tag', value: t,
      without: (x: ViewFilterState) => ({ ...x, tags: x.tags.filter(v => v !== t) }),
    })),
    summary: s => `Tags: ${list(s.tags)}`,
  },
  {
    key: 'visibility',
    isActive: s => s.visibility !== null,
    clear: s => ({ ...s, visibility: null }),
    chips: s => (s.visibility ? [{
      key: 'visibility', dimension: 'visibility', prefix: 'Visibility',
      value: VISIBILITY_LABELS[s.visibility] ?? s.visibility,
      without: x => ({ ...x, visibility: null }),
    }] : []),
    summary: s => `Visibility: ${VISIBILITY_LABELS[s.visibility ?? ''] ?? s.visibility}`,
  },
]

/** The chips for a filter set, in bar order. `hide` drops dimensions a surface
 *  shows some other way (the workspace tab is fixed to its workspace). */
export function filterChips(
  s: ViewFilterState, l: FilterLookups, hide: readonly DimensionKey[] = [],
): FilterChip[] {
  return DIMENSIONS.filter(d => !hide.includes(d.key)).flatMap(d => d.chips(s, l))
}

/** Every dimension narrowing the list, minus those a surface fixes for itself. */
export function activeDimensions(
  s: ViewFilterState, hide: readonly DimensionKey[] = [],
): FilterDimension[] {
  return DIMENSIONS.filter(d => !hide.includes(d.key) && d.isActive(s))
}

/** Clear every dimension except those a surface fixes for itself — the "Clear all"
 *  that keeps a workspace tab in its workspace. */
export function clearDimensions(s: ViewFilterState, keep: readonly DimensionKey[] = []): ViewFilterState {
  return DIMENSIONS.filter(d => !keep.includes(d.key)).reduce((acc, d) => d.clear(acc), s)
}

/** "past 7 days" after a word such as "Updated"; a month or a date keeps its capital. */
function midSentence(period: string): string {
  return /^(Past|Today|Yesterday|This|Last|Since|Until)\b/.test(period)
    ? period[0].toLowerCase() + period.slice(1)
    : period
}

/** Longer than this and a pill stops being a pill. */
const MAX_NAME = 60

/**
 * A name for a saved filter, from what it filters — "Versioned · Updated past 7
 * days · By Ada Lovelace" — so saving takes one click and the name says what the
 * filter does.
 */
export function suggestFilterName(s: ViewFilterState, l: FilterLookups): string {
  const parts = DIMENSIONS.filter(d => d.isActive(s)).map(d => {
    switch (d.key) {
      case 'search': return `"${s.search.trim()}"`
      case 'category': return d.summary(s, l)
      case 'sourceKind': return SOURCE_KIND_LABELS[s.sourceKind ?? 'versioned']
      case 'created': return `Created ${midSentence(describeRule(s.created ?? '', l.today))}`
      case 'updated': return `Updated ${midSentence(describeRule(s.updated ?? '', l.today))}`
      case 'people': {
        const names = list(s.contributorIds.map(id => personLabel(id, l))).replace(/\bYou\b/, 'you')
        return `${s.contributorRole ? ROLE_PREFIX[s.contributorRole] : 'By'} ${names}`
      }
      default: return d.chips(s, l).map(c => c.value).join(', ')
    }
  })
  const name = parts.join(' · ') || 'All views'
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name
}
