import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Sparkles, Shield, CheckCircle2, PenLine, Box, GitBranch, Loader2, BookOpen, Database, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { StatusFilter } from '../lib/ontology-types'

interface OntologySidebarProps {
  ontologies: OntologyDefinitionResponse[]
  selectedOntologyId: string | undefined
  activeDataSource: DataSourceResponse | null
  assignmentCountMap: Map<string, number>
  isLoading: boolean
  isSuggesting: boolean
  onCreateDraft: () => void
  onSuggest: () => void
}

const STATUS_CONFIGS: Record<Exclude<StatusFilter, 'all'>, {
  icon: React.ComponentType<{ className?: string }>
  color: string
  dotColor: string
}> = {
  system: { icon: Shield, color: 'text-indigo-500', dotColor: 'bg-indigo-500' },
  published: { icon: CheckCircle2, color: 'text-emerald-500', dotColor: 'bg-emerald-500' },
  draft: { icon: PenLine, color: 'text-amber-500', dotColor: 'bg-amber-500' },
}

const filters: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
  { id: 'published', label: 'Published' },
  { id: 'draft', label: 'Draft' },
]

function getStatusKey(o: OntologyDefinitionResponse): Exclude<StatusFilter, 'all'> {
  if (o.isSystem) return 'system'
  if (o.isPublished) return 'published'
  return 'draft'
}

export function OntologySidebar({
  ontologies,
  selectedOntologyId,
  activeDataSource,
  assignmentCountMap,
  isLoading,
  isSuggesting,
  onCreateDraft,
  onSuggest,
}: OntologySidebarProps) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const filtered = useMemo(() => {
    let list = ontologies
    if (statusFilter === 'system') list = list.filter(o => o.isSystem)
    else if (statusFilter === 'published') list = list.filter(o => o.isPublished && !o.isSystem)
    else if (statusFilter === 'draft') list = list.filter(o => !o.isPublished && !o.isSystem)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(o => o.name.toLowerCase().includes(q))
    }
    return list
  }, [ontologies, statusFilter, search])

  // Count per status for filter badges
  const counts = useMemo(() => ({
    all: ontologies.length,
    system: ontologies.filter(o => o.isSystem).length,
    published: ontologies.filter(o => o.isPublished && !o.isSystem).length,
    draft: ontologies.filter(o => !o.isPublished && !o.isSystem).length,
  }), [ontologies])

  return (
    <div className="w-[280px] flex-shrink-0 flex flex-col border-r border-glass-border bg-canvas-elevated/40 h-full">
      {/* Search */}
      <div className="px-3 pt-4 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ontologies..."
            className="w-full pl-9 pr-8 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 focus:bg-white dark:focus:bg-white/[0.06] transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted/50 hover:text-ink-muted transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Status filter tabs — segmented control style */}
      <div className="px-3 pb-3">
        <div className="flex rounded-lg bg-black/[0.04] dark:bg-white/[0.04] p-0.5">
          {filters.map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[10px] font-semibold transition-all',
                statusFilter === f.id
                  ? 'bg-white dark:bg-white/10 text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink-secondary'
              )}
            >
              {f.label}
              {counts[f.id] > 0 && (
                <span className={cn(
                  'text-[9px] font-bold tabular-nums',
                  statusFilter === f.id ? 'text-indigo-500' : 'text-ink-muted/50',
                )}>
                  {counts[f.id]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-ink-muted/40" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-ink-muted/40" />
            </div>
            <p className="text-xs font-medium text-ink-secondary">
              {search || statusFilter !== 'all' ? 'No ontologies match' : 'No ontologies yet'}
            </p>
            <p className="text-[11px] text-ink-muted/60 mt-1">
              {search ? 'Try a different search term' : 'Create a new draft to get started'}
            </p>
          </div>
        ) : (
          filtered.map(o => {
            const entityCount = Object.keys(o.entityTypeDefinitions ?? {}).length
            const relCount = Object.keys(o.relationshipTypeDefinitions ?? {}).length
            const isSelected = o.id === selectedOntologyId
            const statusKey = getStatusKey(o)
            const config = STATUS_CONFIGS[statusKey]
            const StatusIcon = config.icon
            const isAssignedToCurrentDs = activeDataSource?.ontologyId === o.id
            const dsCount = assignmentCountMap.get(o.id) ?? 0

            return (
              <button
                key={o.id}
                onClick={() => navigate(`/schema/${o.id}`)}
                className={cn(
                  'w-full text-left rounded-xl p-3 transition-all group relative',
                  isSelected
                    ? 'bg-gradient-to-r from-indigo-500/[0.08] to-violet-500/[0.04] dark:from-indigo-500/[0.12] dark:to-violet-500/[0.06] ring-1 ring-indigo-500/20 shadow-sm'
                    : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
              >
                {/* Row 1: Icon + Name + badges */}
                <div className="flex items-center gap-2.5 mb-1.5">
                  {/* Status dot indicator */}
                  <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
                    isSelected
                      ? 'bg-indigo-500/15 dark:bg-indigo-500/20'
                      : 'bg-black/[0.04] dark:bg-white/[0.06] group-hover:bg-black/[0.06] dark:group-hover:bg-white/[0.08]',
                  )}>
                    <StatusIcon className={cn('w-3.5 h-3.5', isSelected ? 'text-indigo-500' : config.color)} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn(
                        'text-[13px] font-semibold truncate',
                        isSelected ? 'text-ink' : 'text-ink-secondary group-hover:text-ink',
                      )}>
                        {o.name}
                      </span>
                      {isAssignedToCurrentDs && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-[8px] font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0 ring-1 ring-emerald-500/20">
                          <Database className="w-2 h-2" />
                          ACTIVE
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Row 2: Meta info */}
                <div className="flex items-center gap-2 ml-[38px]">
                  <span className={cn(
                    'text-[10px] font-medium',
                    isSelected ? 'text-indigo-500/70' : 'text-ink-muted/60',
                  )}>
                    v{o.version}
                  </span>
                  <span className="text-ink-muted/20">·</span>
                  <span className={cn(
                    'inline-flex items-center gap-0.5 text-[10px]',
                    isSelected ? 'text-ink-muted' : 'text-ink-muted/60',
                  )}>
                    <Box className="w-2.5 h-2.5" />
                    {entityCount}
                  </span>
                  <span className={cn(
                    'inline-flex items-center gap-0.5 text-[10px]',
                    isSelected ? 'text-ink-muted' : 'text-ink-muted/60',
                  )}>
                    <GitBranch className="w-2.5 h-2.5" />
                    {relCount}
                  </span>
                  {dsCount > 0 && !isAssignedToCurrentDs && (
                    <>
                      <span className="text-ink-muted/20">·</span>
                      <span className="text-[10px] text-ink-muted/50" title={`Assigned to ${dsCount} data source${dsCount !== 1 ? 's' : ''}`}>
                        {dsCount} ds
                      </span>
                    </>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* Bottom actions */}
      <div className="border-t border-glass-border/60 p-3 space-y-2">
        <button
          onClick={onCreateDraft}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 active:bg-indigo-700 transition-colors shadow-sm shadow-indigo-500/25"
        >
          <Plus className="w-3.5 h-3.5" />
          New Draft
        </button>
        <button
          onClick={onSuggest}
          disabled={isSuggesting}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border border-glass-border/60 hover:border-indigo-400/40 hover:bg-indigo-500/[0.04] text-ink-secondary hover:text-indigo-600 dark:hover:text-indigo-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSuggesting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Sparkles className="w-3.5 h-3.5" />}
          Suggest from Graph
        </button>
      </div>
    </div>
  )
}
