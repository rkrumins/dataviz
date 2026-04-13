/**
 * ExplorerFilterBar — Unified single-row toolbar combining category tabs
 * and filter dropdowns.
 *
 * Layout: [Category pills] | [Workspace ▾] [DataSource ▾] [Visibility ▾]
 *
 * Favourites is exposed only as the "Favorites" category pill — there is
 * no separate toggle because the two controls were functionally identical
 * and confused users who applied one and expected the other to change.
 *
 * Performance: no transition-all, no backdrop-blur on persistent elements.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Layers,
  LayoutGrid,
  Star,
  Clock,
  Share2,
  AlertTriangle,
  Users,
  Globe,
  Lock,
  X,
  ChevronDown,
  Check,
  Database,
  Trash2,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ExplorerFilterBarProps {
  visibility: string | null
  onVisibilityChange: (v: string | null) => void
  workspaceIds: string[]
  onWorkspaceIdsChange: (ids: string[]) => void
  dataSourceId: string | null
  onDataSourceIdChange: (id: string | null) => void
  category: string | null
  onCategoryChange: (c: string | null) => void
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CATEGORIES = [
  { key: null, label: 'All', icon: Layers },
  { key: 'my-views', label: 'My Views', icon: LayoutGrid },
  { key: 'my-favourites', label: 'Favorites', icon: Star },
  { key: 'recently-added', label: 'Recent', icon: Clock },
  { key: 'shared-with-me', label: 'Shared', icon: Share2 },
  { key: 'needs-attention', label: 'Attention', icon: AlertTriangle },
  { key: 'deleted', label: 'Deleted', icon: Trash2 },
] as const

const VISIBILITY_OPTIONS = [
  { key: null, label: 'Any visibility', icon: Layers },
  { key: 'enterprise', label: 'Enterprise', icon: Globe },
  { key: 'workspace', label: 'Workspace', icon: Users },
  { key: 'private', label: 'Private', icon: Lock },
] as const

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerFilterBar({
  visibility,
  onVisibilityChange,
  workspaceIds,
  onWorkspaceIdsChange,
  dataSourceId,
  onDataSourceIdChange,
  category,
  onCategoryChange,
}: ExplorerFilterBarProps) {
  const workspaces = useWorkspacesStore(s => s.workspaces)

  const [wsOpen, setWsOpen] = useState(false)
  const [dsOpen, setDsOpen] = useState(false)
  const [visOpen, setVisOpen] = useState(false)

  const [wsSearch, setWsSearch] = useState('')
  const [dsSearch, setDsSearch] = useState('')
  const wsSearchRef = useRef<HTMLInputElement>(null)
  const dsSearchRef = useRef<HTMLInputElement>(null)

  const wsRef = useRef<HTMLDivElement>(null)
  const dsRef = useRef<HTMLDivElement>(null)
  const visRef = useRef<HTMLDivElement>(null)

  const closeWs = useCallback(() => { setWsOpen(false); setWsSearch('') }, [])
  const closeDs = useCallback(() => { setDsOpen(false); setDsSearch('') }, [])
  const closeVis = useCallback(() => setVisOpen(false), [])

  useClickOutside(wsRef, closeWs)
  useClickOutside(dsRef, closeDs)
  useClickOutside(visRef, closeVis)

  // Auto-focus search inputs when dropdowns open
  useEffect(() => { if (wsOpen) wsSearchRef.current?.focus() }, [wsOpen])
  useEffect(() => { if (dsOpen) dsSearchRef.current?.focus() }, [dsOpen])

  const availableDataSources = useMemo(() => {
    const selected = workspaceIds.length > 0
      ? workspaces.filter(w => workspaceIds.includes(w.id))
      : workspaces
    return selected.flatMap(w => w.dataSources ?? [])
  }, [workspaces, workspaceIds])

  const filteredWorkspaces = useMemo(() => {
    if (!wsSearch.trim()) return workspaces
    const q = wsSearch.toLowerCase()
    return workspaces.filter(w => w.name.toLowerCase().includes(q))
  }, [workspaces, wsSearch])

  const filteredDataSources = useMemo(() => {
    if (!dsSearch.trim()) return availableDataSources
    const q = dsSearch.toLowerCase()
    return availableDataSources.filter(d => (d.label ?? d.id).toLowerCase().includes(q))
  }, [availableDataSources, dsSearch])

  // Active filter chips — each chip is labeled with its filter type so users
  // can see where the value comes from (e.g. "Workspace: Production").
  // Categories (including "Favorites") render as pills above, not chips, so
  // they aren't duplicated here.
  const activeFilters = useMemo(() => {
    const chips: { key: string; prefix: string; value: string }[] = []
    if (visibility) {
      const opt = VISIBILITY_OPTIONS.find(o => o.key === visibility)
      chips.push({ key: 'visibility', prefix: 'Visibility', value: opt?.label ?? visibility })
    }
    for (const wsId of workspaceIds) {
      const ws = workspaces.find(w => w.id === wsId)
      chips.push({ key: `ws-${wsId}`, prefix: 'Workspace', value: ws?.name ?? wsId })
    }
    if (dataSourceId) {
      const ds = availableDataSources.find(d => d.id === dataSourceId)
      chips.push({ key: 'ds', prefix: 'Source', value: ds?.label ?? dataSourceId })
    }
    return chips
  }, [visibility, workspaceIds, dataSourceId, workspaces, availableDataSources])

  function removeFilter(key: string) {
    if (key === 'visibility') onVisibilityChange(null)
    else if (key.startsWith('ws-')) onWorkspaceIdsChange(workspaceIds.filter(w => w !== key.replace('ws-', '')))
    else if (key === 'ds') onDataSourceIdChange(null)
  }

  function clearAll() {
    onVisibilityChange(null)
    onWorkspaceIdsChange([])
    onDataSourceIdChange(null)
  }

  function toggleWorkspace(id: string) {
    onWorkspaceIdsChange(
      workspaceIds.includes(id)
        ? workspaceIds.filter(w => w !== id)
        : [...workspaceIds, id]
    )
  }

  const visLabel = VISIBILITY_OPTIONS.find(o => o.key === visibility)?.label

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="space-y-3">
      {/* ── Single unified row: categories + filter dropdowns ── */}
      <div className="flex items-center gap-1 flex-wrap">
        {/* Category pills */}
        {CATEGORIES.map(tab => {
          const active = category === tab.key
          const Icon = tab.icon
          return (
            <button
              key={tab.key ?? '__all'}
              onClick={() => onCategoryChange(tab.key)}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium',
                'transition-colors duration-150',
                active
                  ? 'bg-accent-lineage/12 text-accent-lineage'
                  : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}

        {/* Separator */}
        <div className="w-px h-5 bg-glass-border mx-1.5" />

        {/* Workspace dropdown */}
        <div ref={wsRef} className="relative">
          <button
            onClick={() => { if (wsOpen) closeWs(); else setWsOpen(true); closeDs(); closeVis() }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              workspaceIds.length > 0
                ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
            )}
          >
            <Users className="h-3.5 w-3.5" />
            {workspaceIds.length > 0 ? `${workspaceIds.length} workspace${workspaceIds.length > 1 ? 's' : ''}` : 'Workspace'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', wsOpen && 'rotate-180')} />
          </button>

          {wsOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden">
              <div className="relative border-b border-glass-border/50 p-2">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-muted/60 pointer-events-none" />
                <input
                  ref={wsSearchRef}
                  type="text"
                  value={wsSearch}
                  onChange={e => setWsSearch(e.target.value)}
                  placeholder="Search workspaces..."
                  className="w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.04] pl-7 pr-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:bg-black/[0.05] dark:focus:bg-white/[0.06]"
                  onKeyDown={e => e.stopPropagation()}
                />
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                {workspaces.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No workspaces</p>
                )}
                {workspaces.length > 0 && filteredWorkspaces.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No matches</p>
                )}
                {filteredWorkspaces.map(ws => {
                  const checked = workspaceIds.includes(ws.id)
                  return (
                    <button
                      key={ws.id}
                      onClick={() => toggleWorkspace(ws.id)}
                      className={cn(
                        'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs',
                        'transition-colors duration-150',
                        checked ? 'bg-indigo-500/8 text-indigo-600 dark:text-indigo-400' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                      )}
                    >
                      <span className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                        'transition-colors duration-150',
                        checked ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-glass-border',
                      )}>
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="font-medium truncate">{ws.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Data Source dropdown */}
        <div ref={dsRef} className="relative">
          <button
            onClick={() => { if (dsOpen) closeDs(); else setDsOpen(true); closeWs(); closeVis() }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              dataSourceId
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
            )}
          >
            <Database className="h-3.5 w-3.5" />
            {dataSourceId
              ? (availableDataSources.find(d => d.id === dataSourceId)?.label ?? 'Source')
              : 'Source'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', dsOpen && 'rotate-180')} />
          </button>

          {dsOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden">
              <div className="relative border-b border-glass-border/50 p-2">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-muted/60 pointer-events-none" />
                <input
                  ref={dsSearchRef}
                  type="text"
                  value={dsSearch}
                  onChange={e => setDsSearch(e.target.value)}
                  placeholder="Search sources..."
                  className="w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.04] pl-7 pr-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:bg-black/[0.05] dark:focus:bg-white/[0.06]"
                  onKeyDown={e => e.stopPropagation()}
                />
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                <button
                  onClick={() => { onDataSourceIdChange(null); closeDs() }}
                  className={cn(
                    'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150',
                    !dataSourceId ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                  )}
                >
                  All sources
                </button>
                {availableDataSources.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No data sources</p>
                )}
                {availableDataSources.length > 0 && filteredDataSources.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No matches</p>
                )}
                {filteredDataSources.map(ds => (
                  <button
                    key={ds.id}
                    onClick={() => { onDataSourceIdChange(ds.id); closeDs() }}
                    className={cn(
                      'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150 truncate',
                      dataSourceId === ds.id ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                    )}
                  >
                    {ds.label ?? ds.id}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Visibility dropdown */}
        <div ref={visRef} className="relative">
          <button
            onClick={() => { setVisOpen(p => !p); closeWs(); closeDs() }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              visibility
                ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
            )}
          >
            <Globe className="h-3.5 w-3.5" />
            {visLabel ?? 'Visibility'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', visOpen && 'rotate-180')} />
          </button>

          {visOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-48 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl">
              {VISIBILITY_OPTIONS.map(opt => {
                const active = visibility === opt.key
                const Icon = opt.icon
                return (
                  <button
                    key={opt.key ?? '__all'}
                    onClick={() => { onVisibilityChange(opt.key); setVisOpen(false) }}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors duration-150',
                      active ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {opt.label}
                    {active && <Check className="h-3 w-3 ml-auto" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {/* ── Active filter chips ── */}
      <AnimatePresence>
        {activeFilters.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-wrap items-center gap-1.5 overflow-hidden"
          >
            {activeFilters.map(f => (
              <span
                key={f.key}
                className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas-elevated pl-2.5 pr-1 py-1 text-[11px]"
              >
                <span className="text-ink-muted/60 font-medium">{f.prefix}:</span>
                <span className="font-semibold text-ink">{f.value}</span>
                <button
                  onClick={() => removeFilter(f.key)}
                  className="rounded-full p-0.5 text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150"
                  title="Remove filter"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            <button
              onClick={clearAll}
              className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors duration-150 underline underline-offset-2"
            >
              Clear all
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
