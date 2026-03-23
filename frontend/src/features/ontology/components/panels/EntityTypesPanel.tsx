import { useState, useMemo } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

import type { EntityTypeSchema } from '@/types/schema'
import type { EntityTypeSummary } from '@/providers/GraphDataProvider'
import { EmptyState } from '../EmptyState'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { formatCount } from '../../lib/ontology-parsers'
import type { EditorPanel } from '../../lib/ontology-types'

// ---------------------------------------------------------------------------
// EntityTypeRow — single entity type mini-card
// ---------------------------------------------------------------------------

export function EntityTypeRow({
  entityType: et,
  graphCount,
  isLocked,
  isEditing,
  isChanged,
  validationIssues,
  onEdit,
  onDelete,
}: {
  entityType: EntityTypeSchema
  graphCount?: number
  isLocked: boolean
  isEditing: boolean
  isChanged?: boolean
  validationIssues?: Array<{ severity: string; message: string }>
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
        {/* Color swatch + icon */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ring-1 ring-black/5 dark:ring-white/5"
          style={{ backgroundColor: `${et.visual.color}18` }}
        >
          <DynamicIcon
            name={et.visual.icon}
            className="w-5 h-5"
            style={{ color: et.visual.color }}
          />
        </div>

        {/* Center: name, description, badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-sm text-ink truncate">{et.name}</span>
            <code className="text-[10px] text-ink-muted/60 font-mono hidden sm:inline">{et.id}</code>
            {isChanged && (
              <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" title="Modified" />
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {et.description && (
              <span className="text-[11px] text-ink-muted truncate max-w-[200px]">{et.description}</span>
            )}
            {!et.description && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-medium">
                  L{et.hierarchy.level}
                </span>
                {et.hierarchy.canContain.length > 0 && (
                  <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded font-medium">
                    container
                  </span>
                )}
                {et.behavior.traceable && (
                  <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded font-medium">
                    traceable
                  </span>
                )}
              </div>
            )}
          </div>
          {et.description && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1">
              <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-medium">
                L{et.hierarchy.level}
              </span>
              {et.fields.length > 0 && (
                <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-medium">
                  {et.fields.length} field{et.fields.length !== 1 ? 's' : ''}
                </span>
              )}
              {et.hierarchy.canContain.length > 0 && (
                <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded font-medium">
                  container
                </span>
              )}
              {et.behavior.traceable && (
                <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded font-medium">
                  traceable
                </span>
              )}
            </div>
          )}
          {/* Inline validation issues */}
          {validationIssues && validationIssues.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <LucideIcons.AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
              <span className="text-[10px] text-red-600 dark:text-red-400 truncate">
                {validationIssues[0].message}
                {validationIssues.length > 1 && ` (+${validationIssues.length - 1} more)`}
              </span>
            </div>
          )}
        </div>

        {/* Right: graph count + hover actions */}
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

          {/* Hover-reveal actions */}
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
// EntityTypesPanel — the main panel (renamed from EntitiesTab)
// ---------------------------------------------------------------------------

export function EntityTypesPanel({
  entityTypes,
  entityStatMap,
  isLocked,
  search,
  validationResult,
  editorPanel,
  changedIds,
  onSearch,
  onEdit,
  onNew,
  onDelete,
  onDismissValidation,
}: {
  entityTypes: EntityTypeSchema[]
  entityStatMap: Map<string, EntityTypeSummary>
  isLocked: boolean
  search: string
  validationResult: { isValid: boolean; issues: Array<{ severity: string; message: string }> } | null
  editorPanel: EditorPanel
  changedIds?: Set<string>
  onSearch: (s: string) => void
  onEdit: (et: EntityTypeSchema) => void
  onNew: () => void
  onDelete: (id: string, name: string) => void
  onDismissValidation: () => void
}) {
  const [showStagedOnly, setShowStagedOnly] = useState(false)
  const hasChanges = changedIds && changedIds.size > 0

  const filtered = useMemo(() => {
    let list = entityTypes
    if (showStagedOnly && changedIds && changedIds.size > 0) {
      list = list.filter(et => changedIds.has(et.id))
    }
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(et =>
      et.name.toLowerCase().includes(q) || et.id.toLowerCase().includes(q)
    )
  }, [entityTypes, search, showStagedOnly, changedIds])

  // Build a map from entity type id to validation issues that mention it
  const validationIssuesByType = useMemo(() => {
    if (!validationResult || validationResult.isValid) return new Map<string, Array<{ severity: string; message: string }>>()
    const map = new Map<string, Array<{ severity: string; message: string }>>()
    for (const issue of validationResult.issues) {
      for (const et of entityTypes) {
        if (issue.message.toLowerCase().includes(et.id.toLowerCase()) || issue.message.toLowerCase().includes(et.name.toLowerCase())) {
          const existing = map.get(et.id) ?? []
          existing.push(issue)
          map.set(et.id, existing)
        }
      }
    }
    return map
  }, [validationResult, entityTypes])

  return (
    <div>
      {/* Inline validation */}
      {validationResult && (
        <div className={cn(
          'mb-5 p-3 rounded-xl text-xs',
          validationResult.isValid
            ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
            : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
        )}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5">
              {validationResult.isValid
                ? <LucideIcons.CheckCircle2 className="w-3.5 h-3.5" />
                : <LucideIcons.AlertCircle className="w-3.5 h-3.5" />}
              <span className="font-medium">
                {validationResult.isValid
                  ? 'Semantic layer is valid'
                  : `${validationResult.issues.filter(i => i.severity === 'error').length} error(s) found`}
              </span>
            </div>
            {onDismissValidation && (
              <button onClick={onDismissValidation} className="opacity-50 hover:opacity-100">
                <LucideIcons.X className="w-3 h-3" />
              </button>
            )}
          </div>
          {validationResult.issues.slice(0, 4).map((issue, i) => (
            <p key={i} className="opacity-80 leading-snug">
              {issue.severity === 'error' ? '  ' : '  '} {issue.message}
            </p>
          ))}
        </div>
      )}

      {/* Search bar + staged filter */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <LucideIcons.Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input
            type="text"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Search entity types by name or ID..."
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
        {hasChanges && (
          <button
            onClick={() => setShowStagedOnly(v => !v)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all whitespace-nowrap',
              showStagedOnly
                ? 'bg-amber-500 text-white border-amber-500 shadow-sm shadow-amber-500/20'
                : 'bg-amber-50 dark:bg-amber-950/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/50 hover:bg-amber-100 dark:hover:bg-amber-950/40',
            )}
          >
            <LucideIcons.Filter className="w-3.5 h-3.5" />
            Staged ({changedIds!.size})
          </button>
        )}
      </div>

      {/* Results count when filtering */}
      {(search || showStagedOnly) && filtered.length > 0 && (
        <p className="text-[11px] text-ink-muted mb-3">
          {filtered.length} of {entityTypes.length} entity type{entityTypes.length !== 1 ? 's' : ''}{search ? ` match "${search}"` : ''}{showStagedOnly ? ' (staged only)' : ''}
        </p>
      )}

      {/* Entity type list */}
      {filtered.length === 0 ? (
        <EmptyState
          icon="Box"
          message={search ? 'No entity types match your search' : 'No entity types defined yet.'}
          hint={!search && !isLocked ? 'Use "Suggest from Graph" in the Library tab to auto-generate, or add manually.' : undefined}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map(et => (
            <EntityTypeRow
              key={et.id}
              entityType={et}
              graphCount={entityStatMap.get(et.id.toLowerCase())?.count}
              isLocked={isLocked}
              isEditing={editorPanel?.kind === 'entity' && editorPanel.data?.id === et.id}
              isChanged={changedIds?.has(et.id)}
              validationIssues={validationIssuesByType.get(et.id)}
              onEdit={() => onEdit(et)}
              onDelete={() => onDelete(et.id, et.name)}
            />
          ))}

          {/* Add Entity Type card */}
          {!isLocked && (
            <button
              onClick={onNew}
              className="w-full p-4 rounded-xl border-2 border-dashed border-glass-border hover:border-indigo-400 dark:hover:border-indigo-500 bg-transparent hover:bg-indigo-50/30 dark:hover:bg-indigo-950/10 transition-all group flex items-center justify-center gap-3"
            >
              <div className="w-10 h-10 rounded-lg border-2 border-dashed border-glass-border group-hover:border-indigo-400 flex items-center justify-center transition-colors">
                <LucideIcons.Plus className="w-5 h-5 text-ink-muted group-hover:text-indigo-500 transition-colors" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-ink-muted group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">Add Entity Type</p>
                <p className="text-[11px] text-ink-muted/60">Define a new node type for your semantic layer</p>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
