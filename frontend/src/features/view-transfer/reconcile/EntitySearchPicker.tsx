/**
 * Point an entity the view places at another entity here: search the data source the view is
 * going into (on the draft it's checked against, if any) by name, and pick one. It starts from
 * the entity's name in the file, since the usual case is the same entity under another URN.
 *
 * A URN can be pasted too, for an entity search doesn't surface; without a data source to search
 * (no scope) that is the only way.
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { getOrCreateProvider } from '@/providers/providerPool'
import type { BundleEntityInfo } from '@/services/viewTransferApiService'

export interface EntitySearchScope {
  workspaceId: string
  dataSourceId: string | null
  /** The draft the view is checked against (its data counts as here). */
  branchId?: string | null
}

const RESULT_LIMIT = 8
const MIN_QUERY = 2

const looksLikeUrn = (q: string) => /^[a-z][\w.+-]*:\S+$/i.test(q)

export function EntitySearchPicker({ scope, exported, current, onPick, onCancel }: {
  scope?: EntitySearchScope | null
  /** The entity being remapped, as the file names it. */
  exported: BundleEntityInfo | null
  /** Where it's remapped to already, if it is. */
  current?: string
  onPick: (urn: string) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState(current ?? (scope ? exported?.name ?? '' : ''))
  const [active, setActive] = useState(0)
  const listId = useId()
  const q = query.trim()
  const debounced = useDebouncedValue(q, 250)

  const search = useQuery({
    queryKey: ['view-transfer', 'entity-search', scope?.workspaceId, scope?.dataSourceId, scope?.branchId ?? null, debounced],
    queryFn: async () => {
      const provider = getOrCreateProvider(scope!.workspaceId, scope!.dataSourceId, scope!.branchId)
      const nodes = await provider.searchNodes(debounced, RESULT_LIMIT)
      return nodes.map(n => ({ urn: n.urn, name: n.displayName || n.urn, type: n.entityType }))
    },
    enabled: !!scope && debounced.length >= MIN_QUERY,
    staleTime: 30_000,
    retry: false,
  })
  const hits = debounced === q ? search.data ?? [] : []
  const pasted = looksLikeUrn(q) && !hits.some(h => h.urn === q) ? q : null
  const options = [...hits.map(h => h.urn), ...(pasted ? [pasted] : [])]
  const at = Math.min(active, Math.max(options.length - 1, 0))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length) setActive((at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (options[at]) onPick(options[at])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  const searching = !!scope && q.length >= MIN_QUERY && (debounced !== q || search.isFetching)
  return (
    <div className="space-y-2">
      <p className="px-1 text-[11px] text-ink-muted">
        Point <span className="font-semibold text-ink-secondary">{exported?.name || 'this entity'}</span>
        {exported?.type ? ` (${exported.type})` : ''} at an entity here instead.
      </p>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
        <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown}
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={options[at] ? `${listId}-${at}` : undefined}
          aria-label={scope ? 'Search for the entity here, or paste its URN' : 'URN of the entity here'}
          placeholder={scope ? 'Search by name, or paste a URN' : 'Paste the URN of the entity here'}
          className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-glass-border bg-transparent text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500" />
        {searching && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-indigo-500 animate-spin" />}
      </div>

      <ul id={listId} role="listbox" aria-label="Entities here" className="max-h-60 overflow-y-auto custom-scrollbar space-y-0.5">
        {hits.map((h, i) => (
          <li key={h.urn} id={`${listId}-${i}`} role="option" aria-selected={i === at}
            onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => onPick(h.urn)}
            className={cn('px-2 py-1.5 rounded-md cursor-pointer', i === at ? 'bg-indigo-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-ink truncate">{h.name}</span>
              {h.type && <span className="ml-auto shrink-0 text-[10px] text-ink-muted">{h.type}</span>}
            </div>
            <p className="text-[10px] font-mono text-ink-muted truncate" title={h.urn}>{h.urn}</p>
          </li>
        ))}
        {pasted && (
          <li id={`${listId}-${hits.length}`} role="option" aria-selected={at === hits.length}
            onMouseEnter={() => setActive(hits.length)} onMouseDown={e => e.preventDefault()} onClick={() => onPick(pasted)}
            className={cn('flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs',
              at === hits.length ? 'bg-indigo-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
            <CornerDownLeft className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <span className="min-w-0 truncate">Use <span className="font-mono">{pasted}</span></span>
          </li>
        )}
      </ul>

      {scope && q.length >= MIN_QUERY && !searching && !hits.length && (
        <p className="px-1 text-[11px] text-ink-muted">
          {search.isError
            ? 'Search isn’t available right now. Paste the entity’s URN instead.'
            : `Nothing here matches “${q}”.`}
        </p>
      )}
      {scope && q.length < MIN_QUERY && !pasted && (
        <p className="px-1 text-[11px] text-ink-muted">Type at least two characters of its name.</p>
      )}
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="px-2 py-1 rounded-md text-[11px] text-ink-muted hover:text-ink">Cancel</button>
      </div>
    </div>
  )
}
