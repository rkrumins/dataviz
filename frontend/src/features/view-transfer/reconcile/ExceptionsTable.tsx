/**
 * Every entity the view places that isn't simply "found, same name, same type" — and what to do
 * with each: keep it (the default: it stays in the view, marked not found here, and lights up if
 * it appears later), drop it, or point it at another entity.
 *
 * Tabs by status, plus the decisions already made (dropped and remapped entities leave the
 * report once re-checked, so this is where they can be seen and taken back). Search, a layer
 * filter and bulk actions, because a real view can have thousands of these; past a hundred rows
 * the list virtualises.
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRight, Search, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BundleEntityInfo, ReconcileException, Resolutions } from '@/services/viewTransferApiService'
import { decisionOf, withDecision, withDecisions, type EntityDecision } from './resolutions'

type Tab = 'missing' | 'type_changed' | 'renamed' | 'unknown' | 'decided'

const TAB_LABEL: Record<Tab, string> = {
  missing: 'Not found',
  type_changed: 'Type changed',
  renamed: 'Renamed',
  unknown: 'Not checked',
  decided: 'Your changes',
}

const VIRTUALIZE_ABOVE = 100
const ROW_HEIGHT = 52

function shortUrn(urn: string): string {
  return urn.length > 64 ? `…${urn.slice(-60)}` : urn
}

interface Row {
  urn: string
  status: ReconcileException['status'] | 'decided'
  exported: BundleEntityInfo | null
  target: BundleEntityInfo | null
  layerId: string | null
}

export function ExceptionsTable({ entities, truncated, draft, onDraft, applied, layerNames, exportedNames }: {
  entities: ReconcileException[]
  truncated: boolean
  draft: Resolutions
  onDraft: (next: Resolutions) => void
  /** Decisions the report already reflects (dropped / remapped entities are no longer in it). */
  applied: Resolutions
  layerNames: Record<string, string>
  /** The file's names for its entities (for decided rows, which the report no longer lists). */
  exportedNames: Record<string, BundleEntityInfo>
}) {
  const decidedRows = useMemo<Row[]>(() => {
    const urns = new Set([...(applied.drop ?? []), ...Object.keys(applied.remap ?? {}),
      ...(draft.drop ?? []), ...Object.keys(draft.remap ?? {})])
    const inReport = new Set(entities.map(e => e.urn))
    return [...urns].filter(u => !inReport.has(u)).sort().map(urn => ({
      urn, status: 'decided' as const, exported: exportedNames[urn] ?? null, target: null, layerId: null,
    }))
  }, [applied, draft, entities, exportedNames])

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { missing: 0, type_changed: 0, renamed: 0, unknown: 0, decided: decidedRows.length }
    for (const e of entities) c[e.status] += 1
    return c
  }, [entities, decidedRows])

  const firstTab = (['missing', 'type_changed', 'unknown', 'renamed', 'decided'] as Tab[]).find(t => counts[t] > 0) ?? 'missing'
  const [tab, setTab] = useState<Tab>(firstTab)
  const [search, setSearch] = useState('')
  const [layer, setLayer] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const rows = useMemo<Row[]>(() => {
    const source: Row[] = tab === 'decided' ? decidedRows
      : entities.filter(e => e.status === tab).map(e => ({ ...e }))
    const q = search.trim().toLowerCase()
    return source.filter(r => (!layer || r.layerId === layer)
      && (!q || r.urn.toLowerCase().includes(q) || (r.exported?.name ?? '').toLowerCase().includes(q)))
  }, [tab, entities, decidedRows, search, layer])

  const setDecision = (urns: string[], decision: EntityDecision) => {
    onDraft(urns.length === 1 ? withDecision(draft, urns[0], decision) : withDecisions(draft, urns, decision))
    setSelected(new Set())
  }

  const layersPresent = useMemo(() => [...new Set(entities.map(e => e.layerId).filter((l): l is string => !!l))], [entities])
  const visibleTabs = (Object.keys(TAB_LABEL) as Tab[]).filter(t => counts[t] > 0 || t === tab)
  const selectedUrns = [...selected].filter(u => rows.some(r => r.urn === u))

  if (entities.length === 0 && decidedRows.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-6 text-center">
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Every entity was found here, with the same name and type.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-glass-border overflow-hidden">
      <div className="flex items-center gap-1 px-2 pt-2 border-b border-glass-border/60 overflow-x-auto" role="tablist">
        {visibleTabs.map(t => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => { setTab(t); setSelected(new Set()) }}
            className={cn('px-3 py-1.5 rounded-t-lg text-xs font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors',
              tab === t ? 'border-indigo-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>
            {TAB_LABEL[t]} <span className="ml-1 tabular-nums text-ink-muted">{counts[t].toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-glass-border/60 bg-black/[0.01] dark:bg-white/[0.01]">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or URN"
            aria-label="Search entities"
            className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg border border-glass-border bg-transparent text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500" />
        </div>
        {tab !== 'decided' && layersPresent.length > 1 && (
          <select value={layer} onChange={e => setLayer(e.target.value)} aria-label="Filter by layer"
            className="text-xs rounded-lg border border-glass-border bg-canvas-elevated px-2 py-1.5 text-ink">
            <option value="">All layers</option>
            {layersPresent.map(id => <option key={id} value={id}>{layerNames[id] ?? id}</option>)}
          </select>
        )}
        {selectedUrns.length > 0 ? (
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-ink-muted">{selectedUrns.length} selected</span>
            <button type="button" onClick={() => setDecision(selectedUrns, { kind: 'drop' })}
              className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10">Drop</button>
            <button type="button" onClick={() => setDecision(selectedUrns, { kind: 'keep' })}
              className="px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">Keep</button>
          </div>
        ) : tab === 'missing' && rows.length > 0 && (
          <button type="button" onClick={() => setDecision(rows.map(r => r.urn), { kind: 'drop' })}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10 whitespace-nowrap">
            Drop all {rows.length.toLocaleString()}
          </button>
        )}
      </div>

      <RowList rows={rows} draft={draft} layerNames={layerNames} selected={selected}
        onToggle={(urn) => setSelected(prev => { const next = new Set(prev); if (next.has(urn)) next.delete(urn); else next.add(urn); return next })}
        onDecide={(urn, d) => setDecision([urn], d)} />

      {truncated && (
        <p className="px-3 py-2 text-[11px] text-ink-muted border-t border-glass-border/60">
          Showing the first {entities.length.toLocaleString()}. Decisions made here apply to these; drop or keep the rest in bulk after re-checking.
        </p>
      )}
    </div>
  )
}

function RowList({ rows, draft, layerNames, selected, onToggle, onDecide }: {
  rows: Row[]
  draft: Resolutions
  layerNames: Record<string, string>
  selected: Set<string>
  onToggle: (urn: string) => void
  onDecide: (urn: string, decision: EntityDecision) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = rows.length > VIRTUALIZE_ABOVE
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-ink-muted">Nothing here matches.</p>
  }

  const render = (row: Row) => (
    <ExceptionRow key={row.urn} row={row} decision={decisionOf(draft, row.urn)} layerName={row.layerId ? layerNames[row.layerId] ?? row.layerId : null}
      selected={selected.has(row.urn)} onToggle={() => onToggle(row.urn)} onDecide={d => onDecide(row.urn, d)} />
  )

  if (!virtual) {
    return <div className="max-h-[360px] overflow-y-auto divide-y divide-glass-border/50">{rows.map(render)}</div>
  }
  return (
    <div ref={scrollRef} className="max-h-[360px] overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => (
          <div key={item.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
            className="border-b border-glass-border/50">
            {render(rows[item.index])}
          </div>
        ))}
      </div>
    </div>
  )
}

function ExceptionRow({ row, decision, layerName, selected, onToggle, onDecide }: {
  row: Row
  decision: EntityDecision
  layerName: string | null
  selected: boolean
  onToggle: () => void
  onDecide: (decision: EntityDecision) => void
}) {
  const [remapping, setRemapping] = useState(false)
  const [remapTo, setRemapTo] = useState(decision.kind === 'remap' ? decision.urn : '')
  const name = row.exported?.name || row.urn.split(/[,:/]/).filter(Boolean).pop() || row.urn

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2 min-h-[52px]', decision.kind === 'drop' && 'bg-rose-500/[0.03]')}>
      {row.status !== 'decided' && (
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${name}`}
          className="w-3.5 h-3.5 rounded accent-indigo-500 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn('text-xs font-medium truncate', decision.kind === 'drop' ? 'text-ink-muted line-through' : 'text-ink')}>{name}</span>
          {row.status === 'renamed' && row.target?.name && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted truncate">
              <ArrowRight className="w-3 h-3 shrink-0" /> <span className="font-medium text-ink-secondary truncate">{row.target.name}</span> here
            </span>
          )}
        </div>
        <p className="text-[10px] font-mono text-ink-muted truncate" title={row.urn}>{shortUrn(row.urn)}</p>
      </div>
      <div className="hidden sm:block w-40 shrink-0 text-[11px] text-ink-muted truncate">
        {row.status === 'type_changed'
          ? <span>{row.exported?.type ?? '?'} <ArrowRight className="inline w-3 h-3" /> <span className="font-semibold text-amber-600 dark:text-amber-400">{row.target?.type ?? '?'}</span></span>
          : row.exported?.type ?? ''}
        {layerName && <span className="block truncate">in {layerName}</span>}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {row.status === 'decided' ? (
          <button type="button" onClick={() => onDecide({ kind: 'keep' })}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
            <Undo2 className="w-3 h-3" /> {decision.kind === 'remap' ? `Undo remap` : decision.kind === 'drop' ? 'Keep instead' : 'Kept'}
          </button>
        ) : remapping ? (
          <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (remapTo.trim()) { onDecide({ kind: 'remap', urn: remapTo.trim() }); setRemapping(false) } }}>
            <input autoFocus value={remapTo} onChange={e => setRemapTo(e.target.value)} placeholder="URN of the entity here"
              aria-label="Remap to URN"
              className="w-44 px-2 py-1 text-[11px] font-mono rounded-lg border border-glass-border bg-transparent text-ink outline-none focus:border-indigo-500" />
            <button type="submit" className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600">Use</button>
            <button type="button" onClick={() => setRemapping(false)} className="px-1.5 py-1 text-[11px] text-ink-muted">Cancel</button>
          </form>
        ) : (
          <div className="inline-flex rounded-lg border border-glass-border p-0.5" role="group" aria-label={`What to do with ${name}`}>
            {(['keep', 'drop', 'remap'] as const).map(kind => (
              <button key={kind} type="button" aria-pressed={decision.kind === kind}
                onClick={() => kind === 'remap' ? setRemapping(true) : onDecide({ kind })}
                title={kind === 'remap' && decision.kind === 'remap' ? decision.urn : undefined}
                className={cn('px-2 py-0.5 rounded-md text-[11px] font-semibold transition-colors capitalize',
                  decision.kind === kind
                    ? kind === 'drop' ? 'bg-rose-500 text-white' : kind === 'remap' ? 'bg-indigo-500 text-white' : 'bg-black/[0.07] dark:bg-white/[0.1] text-ink'
                    : 'text-ink-muted hover:text-ink')}>
                {kind === 'remap' && decision.kind === 'remap' ? 'Remapped' : kind}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
