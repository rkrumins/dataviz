/**
 * ExplorerFilterBar — Unified single-row toolbar combining category tabs
 * and filter dropdowns. No duplication between rows.
 *
 * Layout: [Category pills] | [Workspace ▾] [DataSource ▾] [Visibility ▾] [♥ Fav]
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
  Heart,
  X,
  ChevronDown,
  Check,
  Database,
  Trash2,
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
  favouritedOnly: boolean
  onFavouritedOnlyChange: (v: boolean) => void
  category: string | null
  onCategoryChange: (c: string | null) => void
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CATEGORIES = [
  { key: null, label: 'All', icon: Layers },
  { key: 'my-views', label: 'My Views', icon: LayoutGrid },
  { key: 'my-favourites', label: 'Favourites', icon: Star },
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
  favouritedOnly,
  onFavouritedOnlyChange,
  category,
  onCategoryChange,
}: ExplorerFilterBarProps) {
  const workspaces = useWorkspacesStore(s => s.workspaces)

  const [wsOpen, setWsOpen] = useState(false)
  const [dsOpen, setDsOpen] = useState(false)
  const [visOpen, setVisOpen] = useState(false)

  const wsRef = useRef<HTMLDivElement>(null)
  const dsRef = useRef<HTMLDivElement>(null)
  const visRef = useRef<HTMLDivElement>(null)

  useClickOutside(wsRef, useCallback(() => setWsOpen(false), []))
  useClickOutside(dsRef, useCallback(() => setDsOpen(false), []))
  useClickOutside(visRef, useCallback(() => setVisOpen(false), []))

  const availableDataSources = useMemo(() => {
    const selected = workspaceIds.length > 0
      ? workspaces.filter(w => workspaceIds.includes(w.id))
      : workspaces
    return selected.flatMap(w => w.dataSources ?? [])
  }, [workspaces, workspaceIds])

  // Active filter chips
  const activeFilters = useMemo(() => {
    const chips: { key: string; label: string }[] = []
    if (visibility) {
      const opt = VISIBILITY_OPTIONS.find(o => o.key === visibility)
      chips.push({ key: 'visibility', label: opt?.label ?? visibility })
    }
    for (const wsId of workspaceIds) {
      const ws = workspaces.find(w => w.id === wsId)
      chips.push({ key: `ws-${wsId}`, label: ws?.name ?? wsId })
    }
    if (dataSourceId) {
      const ds = availableDataSources.find(d => d.id === dataSourceId)
      chips.push({ key: 'ds', label: ds?.label ?? dataSourceId })
    }
    if (favouritedOnly) {
      chips.push({ key: 'fav', label: 'Favourites' })
    }
    return chips
  }, [visibility, workspaceIds, dataSourceId, favouritedOnly, workspaces, availableDataSources])

  function removeFilter(key: string) {
    if (key === 'visibility') onVisibilityChange(null)
    else if (key.startsWith('ws-')) onWorkspaceIdsChange(workspaceIds.filter(w => w !== key.replace('ws-', '')))
    else if (key === 'ds') onDataSourceIdChange(null)
    else if (key === 'fav') onFavouritedOnlyChange(false)
  }

  function clearAll() {
    onVisibilityChange(null)
    onWorkspaceIdsChange([])
    onDataSourceIdChange(null)
    onFavouritedOnlyChange(false)
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
            onClick={() => { setWsOpen(p => !p); setDsOpen(false); setVisOpen(false) }}
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
            <div className="absolute left-0 top-full z-50 mt-1.5 w-56 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl">
              {workspaces.length === 0 && (
                <p className="px-3 py-2 text-xs text-ink-muted">No workspaces</p>
              )}
              {workspaces.map(ws => {
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
          )}
        </div>

        {/* Data Source dropdown */}
        <div ref={dsRef} className="relative">
          <button
            onClick={() => { setDsOpen(p => !p); setWsOpen(false); setVisOpen(false) }}
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
            <div className="absolute left-0 top-full z-50 mt-1.5 w-56 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl">
              <button
                onClick={() => { onDataSourceIdChange(null); setDsOpen(false) }}
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
              {availableDataSources.map(ds => (
                <button
                  key={ds.id}
                  onClick={() => { onDataSourceIdChange(ds.id); setDsOpen(false) }}
                  className={cn(
                    'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150',
                    dataSourceId === ds.id ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                  )}
                >
                  {ds.label ?? ds.id}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Visibility dropdown */}
        <div ref={visRef} className="relative">
          <button
            onClick={() => { setVisOpen(p => !p); setWsOpen(false); setDsOpen(false) }}
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

        {/* Favourites toggle */}
        <button
          onClick={() => onFavouritedOnlyChange(!favouritedOnly)}
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
            'transition-colors duration-150',
            favouritedOnly
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
          )}
        >
          <Heart className={cn('h-3.5 w-3.5', favouritedOnly && 'fill-current')} />
          Liked
        </button>
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
                className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.08] px-2.5 py-1 text-[11px] font-medium text-ink-muted"
              >
                {f.label}
                <button
                  onClick={() => removeFilter(f.key)}
                  className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150"
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
