import { useState, useMemo } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

import type { EdgeTypeSummary } from '@/providers/GraphDataProvider'

import { EmptyState } from '../EmptyState'
import { formatCount } from '../../lib/ontology-parsers'
import type { RelTypeWithClassifications, EditorPanel } from '../../lib/ontology-types'

// ---------------------------------------------------------------------------
// RelTypeRow — single relationship type mini-card
// ---------------------------------------------------------------------------

export function RelTypeRow({
  relType: rt,
  graphCount,
  graphSourceTargets,
  isLocked,
  isEditing,
  isChanged,
  onEdit,
  onDelete,
}: {
  relType: RelTypeWithClassifications
  graphCount?: number
  graphSourceTargets?: EdgeTypeSummary
  isLocked: boolean
  isEditing: boolean
  isChanged?: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <button
      onClick={onEdit}
      className={cn(
        'w-full text-left p-3.5 rounded-xl border transition-all group',
        isEditing
          ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
          : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02] hover:shadow-sm'
      )}
    >
      <div className="flex items-center gap-3">
        {/* Edge style preview */}
        <div className="w-14 flex-shrink-0 flex items-center justify-center">
          <svg viewBox="0 0 56 20" className="w-full h-5">
            <line
              x1="4" y1="10" x2="44" y2="10"
              stroke={rt.visual.strokeColor}
              strokeWidth={Math.min(rt.visual.strokeWidth, 3)}
              strokeDasharray={
                rt.visual.strokeStyle === 'dashed' ? '6,4' :
                rt.visual.strokeStyle === 'dotted' ? '2,3' : undefined
              }
              strokeLinecap="round"
            />
            <polygon points="44,6 54,10 44,14" fill={rt.visual.strokeColor} />
          </svg>
        </div>

        {/* Center: name, source->target chips */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-sm text-ink truncate">{rt.name}</span>
            <code className="text-[10px] text-ink-muted/60 font-mono hidden sm:inline">{rt.id.toUpperCase()}</code>
            {isChanged && (
              <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" title="Modified" />
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Source -> Target type chips */}
            {(rt.sourceTypes?.length > 0 || rt.targetTypes?.length > 0) && (
              <div className="flex items-center gap-1 flex-wrap">
                {rt.sourceTypes?.slice(0, 2).map(s => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-ink-secondary font-medium">{s}</span>
                ))}
                {(rt.sourceTypes?.length ?? 0) > 2 && (
                  <span className="text-[10px] text-ink-muted">+{(rt.sourceTypes?.length ?? 0) - 2}</span>
                )}
                <LucideIcons.ArrowRight className="w-3 h-3 text-ink-muted/40 mx-0.5" />
                {rt.targetTypes?.slice(0, 2).map(t => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-ink-secondary font-medium">{t}</span>
                ))}
                {(rt.targetTypes?.length ?? 0) > 2 && (
                  <span className="text-[10px] text-ink-muted">+{(rt.targetTypes?.length ?? 0) - 2}</span>
                )}
              </div>
            )}
            {/* Fallback: graph-observed source/target */}
            {(!rt.sourceTypes || rt.sourceTypes.length === 0) && graphSourceTargets && graphSourceTargets.sourceTypes.length > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-ink-muted italic">{graphSourceTargets.sourceTypes.slice(0, 2).join(', ')}</span>
                <LucideIcons.ArrowRight className="w-3 h-3 text-ink-muted/30" />
                <span className="text-[10px] text-ink-muted italic">{graphSourceTargets.targetTypes.slice(0, 2).join(', ')}</span>
              </div>
            )}
            {rt.bidirectional && (
              <span className="text-[10px] text-blue-500 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 rounded font-medium">
                bidirectional
              </span>
            )}
            {rt.visual.animated && (
              <span className="text-[10px] text-blue-500 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 rounded font-medium">
                animated
              </span>
            )}
          </div>
        </div>

        {/* Right: graph count + actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {graphCount !== undefined && graphCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-2 py-1 rounded-lg font-medium">
              <LucideIcons.BarChart3 className="w-3 h-3" />
              {formatCount(graphCount)}
            </span>
          )}
          {graphCount === 0 && (
            <span className="text-[10px] text-ink-muted/50 italic">unused</span>
          )}

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {!isLocked && (
              <button
                onClick={e => { e.stopPropagation(); onDelete() }}
                className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-950/30 text-ink-muted hover:text-red-500 transition-colors"
                title="Delete"
              >
                <LucideIcons.Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted/40" />
          </div>
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// CollapsibleGroup — collapsible section with chevron
// ---------------------------------------------------------------------------

function CollapsibleGroup({
  label,
  description,
  items,
  accent,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  label: string
  description: string
  items: RelTypeWithClassifications[]
  accent: string
  icon: React.ComponentType<{ className?: string }>
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div>
      {/* Collapsible section header */}
      <button
        onClick={() => setIsOpen(v => !v)}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border mb-3 text-left transition-colors hover:shadow-sm',
          accent
        )}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{label}</h3>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-black/5 dark:bg-white/5">
              {items.length}
            </span>
          </div>
          <p className="text-[11px] opacity-70 truncate">{description}</p>
        </div>
        <LucideIcons.ChevronDown className={cn(
          'w-4 h-4 flex-shrink-0 opacity-50 transition-transform duration-200',
          !isOpen && '-rotate-90'
        )} />
      </button>

      {/* Expanded content */}
      {isOpen && (
        <div className="space-y-2 pl-2 mb-2">
          {items.length === 0 ? (
            <div className="text-center py-6 text-ink-muted">
              <LucideIcons.Ghost className="w-6 h-6 mx-auto mb-2 opacity-20" />
              <p className="text-xs">No {label.toLowerCase()} defined</p>
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RelationshipsPanel — the main panel (renamed from RelationshipsTab)
// ---------------------------------------------------------------------------

export function RelationshipsPanel({
  relTypes,
  edgeStatMap,
  isLocked,
  search,
  editorPanel,
  changedIds,
  onSearch,
  onEdit,
  onNew,
  onDelete,
}: {
  relTypes: RelTypeWithClassifications[]
  edgeStatMap: Map<string, EdgeTypeSummary>
  isLocked: boolean
  search: string
  editorPanel: EditorPanel
  changedIds?: Set<string>
  onSearch: (s: string) => void
  onEdit: (rt: RelTypeWithClassifications) => void
  onNew: () => void
  onDelete: (id: string, name: string) => void
}) {
  const filtered = useMemo(() => {
    if (!search) return relTypes
    const q = search.toLowerCase()
    return relTypes.filter(rt =>
      rt.name.toLowerCase().includes(q) || rt.id.toLowerCase().includes(q)
    )
  }, [relTypes, search])

  // Group by classification
  const containment = filtered.filter(r => r.isContainment)
  const lineage = filtered.filter(r => r.isLineage)
  const other = filtered.filter(r => !r.isContainment && !r.isLineage)

  const groups: Array<{
    id: string
    label: string
    description: string
    items: RelTypeWithClassifications[]
    accent: string
    icon: React.ComponentType<{ className?: string }>
  }> = [
    {
      id: 'containment',
      label: 'Containment Hierarchy',
      description: 'Structural edges defining parent-child nesting (e.g., Domain contains Systems)',
      items: containment,
      accent: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800',
      icon: LucideIcons.FolderTree,
    },
    {
      id: 'lineage',
      label: 'Lineage & Data Flow',
      description: 'Edges tracing data movement and dependencies across the graph',
      items: lineage,
      accent: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800',
      icon: LucideIcons.Workflow,
    },
    {
      id: 'other',
      label: 'Other Relationships',
      description: 'Association, metadata, and reference edges',
      items: other,
      accent: 'text-ink-secondary bg-black/5 dark:bg-white/5 border-glass-border',
      icon: LucideIcons.GitBranch,
    },
  ]

  return (
    <div>
      {/* Search bar — full width with clear button */}
      <div className="relative mb-4">
        <LucideIcons.Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
        <input
          type="text"
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search relationships by name or ID..."
          className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
        />
        {search && (
          <button
            onClick={() => onSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted transition-colors"
          >
            <LucideIcons.X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Results count when searching */}
      {search && filtered.length > 0 && (
        <p className="text-[11px] text-ink-muted mb-3">
          {filtered.length} of {relTypes.length} relationship{relTypes.length !== 1 ? 's' : ''} match "{search}"
        </p>
      )}

      {/* Grouped relationship sections */}
      {filtered.length === 0 ? (
        <EmptyState
          icon="GitBranch"
          message={search ? 'No relationships match your search' : 'No relationship types defined yet.'}
        />
      ) : (
        <div className="space-y-4">
          {groups.map(group => {
            if (group.items.length === 0 && !search) return null
            return (
              <CollapsibleGroup
                key={group.id}
                label={group.label}
                description={group.description}
                items={group.items}
                accent={group.accent}
                icon={group.icon}
              >
                {group.items.map(rt => (
                  <RelTypeRow
                    key={rt.id}
                    relType={rt}
                    graphCount={edgeStatMap.get(rt.id.toUpperCase())?.count}
                    graphSourceTargets={edgeStatMap.get(rt.id.toUpperCase())}
                    isLocked={isLocked}
                    isEditing={editorPanel?.kind === 'rel' && editorPanel.data?.id === rt.id}
                    isChanged={changedIds?.has(rt.id.toUpperCase())}
                    onEdit={() => onEdit(rt)}
                    onDelete={() => onDelete(rt.id, rt.name)}
                  />
                ))}
              </CollapsibleGroup>
            )
          })}

          {/* Add Relationship Type card */}
          {!isLocked && (
            <button
              onClick={onNew}
              className="w-full p-4 rounded-xl border-2 border-dashed border-glass-border hover:border-indigo-400 dark:hover:border-indigo-500 bg-transparent hover:bg-indigo-50/30 dark:hover:bg-indigo-950/10 transition-all group flex items-center justify-center gap-3"
            >
              <div className="w-10 h-10 rounded-lg border-2 border-dashed border-glass-border group-hover:border-indigo-400 flex items-center justify-center transition-colors">
                <LucideIcons.Plus className="w-5 h-5 text-ink-muted group-hover:text-indigo-500 transition-colors" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-ink-muted group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">Add Relationship Type</p>
                <p className="text-[11px] text-ink-muted/60">Define a new edge type for your ontology</p>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
