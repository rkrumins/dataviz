/**
 * AdoptionMatchSection — how well each data source's PHYSICAL graph matches this
 * ontology's DECLARED types, from the periodic profiling stats.
 *
 * Every physical node/edge type is classified:
 *   exact     (emerald) — declared with identical casing → hitting FalkorDB labels/indices
 *   case drift (amber)  — present but wrong casing (physical `has` vs declared `HAS`)
 *   unmapped   (red)    — the ontology doesn't classify it
 *
 * Design intent: this is a health view. It stays CALM when everything is aligned
 * (the common case) and gets LOUD only where there's drift/unmapped — so the eye
 * lands on the one source that needs work, not on 26 identical green rings.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import * as Icons from 'lucide-react'
import { useOntologyAdoption } from '../../hooks/useOntologies'
import type {
  AdoptionDimension,
  AdoptionFacets,
  AdoptionFilter,
  AdoptionSort,
  AdoptionSource,
} from '@/services/ontologyDefinitionService'
import { formatCount } from '../../lib/ontology-parsers'
import { DeclaredVsPhysical } from '../DeclaredVsPhysical'
import { VocabAlignmentWarning } from '@/components/admin/workspace/VocabAlignmentWarning'
import { cn } from '@/lib/utils'

type Mode = 'weighted' | 'by-type'

const PAGE_SIZE = 6

const SEG = {
  exact: 'rgb(16 185 129)',    // emerald-500
  drift: 'rgb(245 158 11)',    // amber-500
  unmapped: 'rgb(239 68 68)',  // red-500
}

// ── helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

interface Segments { exact: number; drift: number; unmapped: number; total: number }

function segmentsOf(dims: (AdoptionDimension | null)[], mode: Mode): Segments {
  let exact = 0, drift = 0, unmapped = 0
  for (const d of dims) {
    if (!d) continue
    if (mode === 'weighted') {
      exact += d.exact.reduce((s, e) => s + e.count, 0)
      drift += d.caseDrift.reduce((s, x) => s + x.count, 0)
      unmapped += d.unmapped.reduce((s, u) => s + u.count, 0)
    } else {
      exact += d.exact.length
      drift += d.caseDrift.length
      unmapped += d.unmapped.length
    }
  }
  return { exact, drift, unmapped, total: exact + drift + unmapped }
}

// ── per-source status (drives glyph, colour, honesty about 0-type graphs) ──────

type RowStatus = 'aligned' | 'drift' | 'unmapped' | 'empty' | 'unprofiled'

interface StatusMeta { Icon: ComponentType<{ className?: string }>; color: string; ring: string }
const STATUS: Record<RowStatus, StatusMeta> = {
  aligned:    { Icon: Icons.CheckCircle2,  color: 'text-emerald-500', ring: SEG.exact },
  drift:      { Icon: Icons.AlertTriangle, color: 'text-amber-500',   ring: SEG.drift },
  unmapped:   { Icon: Icons.XCircle,       color: 'text-red-500',     ring: SEG.unmapped },
  empty:      { Icon: Icons.CircleDashed,  color: 'text-ink-muted',   ring: 'transparent' },
  unprofiled: { Icon: Icons.CircleDashed,  color: 'text-ink-muted/50', ring: 'transparent' },
}

function counts(src: AdoptionSource) {
  const exact = (src.nodes?.exact.length ?? 0) + (src.edges?.exact.length ?? 0)
  const drift = (src.nodes?.caseDrift.length ?? 0) + (src.edges?.caseDrift.length ?? 0)
  const unmapped = (src.nodes?.unmapped.length ?? 0) + (src.edges?.unmapped.length ?? 0)
  const totalTypes = (src.nodes?.totalTypes ?? 0) + (src.edges?.totalTypes ?? 0)
  return { exact, drift, unmapped, totalTypes }
}

function rowStatus(src: AdoptionSource): RowStatus {
  if (!src.profiled) return 'unprofiled'
  const { drift, unmapped, totalTypes } = counts(src)
  if (totalTypes === 0) return 'empty'          // profiled, but nothing to match → not "100%"
  if (unmapped > 0) return 'unmapped'
  if (drift > 0) return 'drift'
  return 'aligned'
}

// ── hero ring (one branded moment; rows use calm bars, not rings) ─────────────

function MatchRing({ seg, pct, size = 92, stroke = 9 }: {
  seg: Segments; pct: number; size?: number; stroke?: number
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const total = seg.total || 1
  const parts = [
    { v: seg.exact, color: SEG.exact },
    { v: seg.drift, color: SEG.drift },
    { v: seg.unmapped, color: SEG.unmapped },
  ]
  let offset = 0
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          className="text-glass-border" stroke="currentColor" />
        {seg.total === 0 ? null : parts.map((p, i) => {
          if (p.v <= 0) return null
          const len = (p.v / total) * c
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
              stroke={p.color} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
              strokeLinecap="butt" style={{ transition: 'stroke-dasharray .6s ease, stroke-dashoffset .6s ease' }} />
          )
          offset += len
          return el
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {seg.total === 0
          ? <Icons.CircleDashed className="w-6 h-6 text-ink-muted/50" />
          : <span className="font-bold tracking-tight text-ink leading-none"
              style={{ fontSize: size * 0.26 }}>{Math.round(pct)}<span className="text-[0.5em]">%</span></span>}
      </div>
    </div>
  )
}

// ── calm per-row health bar (replaces the ring in the list) ───────────────────

function SplitBar({ seg, width = 148 }: { seg: Segments; width?: number }) {
  const total = seg.total || 1
  const parts = [
    { v: seg.exact, color: SEG.exact },
    { v: seg.drift, color: SEG.drift },
    { v: seg.unmapped, color: SEG.unmapped },
  ]
  return (
    <div className="h-1.5 rounded-full overflow-hidden bg-glass-border/70 flex" style={{ width }}>
      {parts.map((p, i) => p.v > 0 && (
        <div key={i} style={{ width: `${(p.v / total) * 100}%`, background: p.color, transition: 'width .5s ease' }} />
      ))}
    </div>
  )
}

function Legend() {
  const items: [string, string, string][] = [
    ['Exact', SEG.exact, 'Declared with identical casing — hitting FalkorDB labels/indices'],
    ['Case drift', SEG.drift, 'Present but wrong casing — won\'t hit the label/index'],
    ['Unmapped', SEG.unmapped, 'Not classified by the ontology'],
  ]
  return (
    <div className="flex items-center gap-3">
      {items.map(([label, color, tip]) => (
        <span key={label} title={tip} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted cursor-help">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />{label}
        </span>
      ))}
    </div>
  )
}

// ── type-breakdown chips (expanded row) ───────────────────────────────────────

/** Exact/drift/unmapped/unused chips for one dimension. Exported for the
 *  per-source PhysicalAlignmentSection (data source profile) — same chip
 *  semantics everywhere alignment is shown. */
export function DimBreakdown({ title, dim }: { title: string; dim: AdoptionDimension | null }) {
  if (!dim || (dim.exact.length + dim.caseDrift.length + dim.unmapped.length + dim.declaredUnused.length) === 0) return null
  const Chip = ({ children, tone, title: t }: { children: ReactNode; tone: 'exact' | 'drift' | 'unmapped' | 'unused'; title?: string }) => {
    const cls = {
      exact: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200/70 dark:border-emerald-800/50',
      drift: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200/70 dark:border-amber-800/50',
      unmapped: 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200/70 dark:border-red-800/50',
      unused: 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border',
    }[tone]
    return <span title={t} className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-mono text-[11px]', cls)}>{children}</span>
  }
  return (
    <div>
      <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-1.5">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {dim.exact.map(e => <Chip key={`e${e.id}`} tone="exact" title={`${formatCount(e.count)} instances`}>{e.id}</Chip>)}
        {dim.caseDrift.map(x => (
          <Chip key={`d${x.id}`} tone="drift" title={`Physical "${x.id}" won't hit the "${x.declared}" label/index — align the casing`}>
            {x.id}<Icons.ArrowRight className="w-2.5 h-2.5 opacity-60" />{x.declared}
          </Chip>
        ))}
        {dim.unmapped.map(u => <Chip key={`u${u.id}`} tone="unmapped" title={`${formatCount(u.count)} instances — not defined in the ontology`}>{u.id}</Chip>)}
        {dim.declaredUnused.map(t => <Chip key={`n${t}`} tone="unused" title="Declared in the ontology but not present in this graph">{t}</Chip>)}
      </div>
    </div>
  )
}

// ── per-source row (compact + calm) ───────────────────────────────────────────

function SourceRow({ src, mode, index }: { src: AdoptionSource; mode: Mode; index: number }) {
  const [open, setOpen] = useState(false)
  const status = rowStatus(src)
  const meta = STATUS[status]
  const seg = segmentsOf([src.nodes, src.edges], mode)
  const pct = (mode === 'weighted' ? src.matchWeighted : src.matchByType) ?? 0
  const { exact, drift, unmapped } = counts(src)
  const stale = src.profiled && !!src.schemaUpdatedAt && (Date.now() - Date.parse(src.schemaUpdatedAt)) > 24 * 3600 * 1000
  const expandable = status === 'aligned' || status === 'drift' || status === 'unmapped'

  // Left accent only where there's a problem — no wall of green stripes.
  const accent = status === 'unmapped'
    ? 'border-l-red-400/80 dark:border-l-red-500/70'
    : status === 'drift'
      ? 'border-l-amber-400/80 dark:border-l-amber-500/70'
      : 'border-l-transparent'
  const pctColor = status === 'unmapped' ? SEG.unmapped : status === 'drift' ? SEG.drift : SEG.exact

  return (
    <div className={cn('rounded-xl border border-glass-border border-l-[3px] bg-canvas-elevated/40 overflow-hidden animate-in fade-in slide-in-from-bottom-1', accent)}
      style={{ animationDelay: `${Math.min(index, 6) * 35}ms`, animationFillMode: 'backwards' }}>
      <button onClick={() => expandable && setOpen(o => !o)}
        className={cn('w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors',
          expandable ? 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]' : 'cursor-default')}>
        <meta.Icon className={cn('w-[18px] h-[18px] flex-shrink-0', meta.color)} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-ink truncate">{src.dataSourceLabel}</span>
            <span className="text-[11px] text-ink-muted truncate">· {src.workspaceName}</span>
          </div>
          <div className="flex items-center gap-2.5 mt-1 min-h-[14px]">
            {seg.total > 0 && <SplitBar seg={seg} />}
            <div className="flex items-center gap-2 text-[11px] min-w-0">
              {status === 'empty' ? (
                <span className="text-ink-muted italic">No types profiled yet</span>
              ) : status === 'unprofiled' ? (
                <span className="text-ink-muted italic">Awaiting first profile</span>
              ) : (
                <>
                  <span className="text-emerald-600 dark:text-emerald-400">{exact} exact</span>
                  {drift > 0 && <span className="text-amber-600 dark:text-amber-400 font-medium">{drift} drift</span>}
                  {unmapped > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{unmapped} unmapped</span>}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {src.profiled && src.schemaUpdatedAt && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-ink-muted">
              <Icons.Clock className="w-3 h-3" />{timeAgo(src.schemaUpdatedAt)}
              {stale && <span className="ml-0.5 px-1 py-px rounded bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400">stale</span>}
            </span>
          )}
          {expandable
            ? <span className="text-sm font-semibold tabular-nums" style={{ color: pctColor }}>{Math.round(pct)}%</span>
            : <span className="text-sm text-ink-muted/60">—</span>}
          {expandable && <Icons.ChevronDown className={cn('w-4 h-4 text-ink-muted/50 transition-transform', open && 'rotate-180')} />}
        </div>
      </button>

      {open && expandable && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-glass-border/60 bg-black/[0.015] dark:bg-white/[0.015] animate-in fade-in slide-in-from-top-1 duration-200">
          {drift > 0 && (
            <>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                <Icons.TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                Case drift means the physical type is present but spelled differently than declared — FalkorDB is case-sensitive, so it won't hit the label/index. It's aligned automatically below; to make the physical graph match natively, use Normalize (opt-in).
              </p>
              {/* Align step (Tier 1). Gated on THIS tab's own (fresh) drift signal so a lagging
                  vocab-alignment profile can't show a false warning on a fully-aligned source;
                  hideMissing drops the non-actionable "defined but not present" line. */}
              <VocabAlignmentWarning wsId={src.workspaceId} dataSourceId={src.dataSourceId} className="" hideMissing />
            </>
          )}
          <DimBreakdown title="Node types" dim={src.nodes} />
          <DimBreakdown title="Edge types" dim={src.edges} />
          {/* The per-source deep dive (grade, index coverage, predicted slow
              queries) lives on the data source's profile. */}
          <Link
            to={`/workspaces/${src.workspaceId}?ds=${encodeURIComponent(src.dataSourceId)}`}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-500 hover:text-indigo-600 transition-colors"
          >
            Full alignment & query-performance analysis
            <Icons.ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  )
}

// ── filter chips ──────────────────────────────────────────────────────────────

const FILTERS: { key: AdoptionFilter; label: string; tone: 'neutral' | 'ok' | 'drift' | 'unmapped' | 'muted' }[] = [
  { key: 'all', label: 'All', tone: 'neutral' },
  { key: 'exact', label: 'Fully aligned', tone: 'ok' },
  { key: 'drift', label: 'Case drift', tone: 'drift' },
  { key: 'unmapped', label: 'Unmapped', tone: 'unmapped' },
  { key: 'unprofiled', label: 'Not profiled', tone: 'muted' },
]

/** Filter chip with a facet count. Exported for the Health tab's sibling
 *  sections (SourceMappingSection) and the assignment Matches tab. */
export function FacetChip({ label, count, tone, active, onClick }: {
  label: string; count: number; tone: 'neutral' | 'ok' | 'drift' | 'unmapped' | 'muted'
  active: boolean; onClick: () => void
}) {
  const hasIssues = (tone === 'drift' || tone === 'unmapped') && count > 0
  const activeCls = {
    neutral: 'bg-accent-lineage/12 text-accent-lineage border-accent-lineage/30',
    ok: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-700/50',
    drift: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300/60 dark:border-amber-700/50',
    unmapped: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-300/60 dark:border-red-700/50',
    muted: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink border-glass-border',
  }[tone]
  const disabled = count === 0 && !active
  return (
    <button onClick={onClick} disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors',
        active ? activeCls : 'border-glass-border text-ink-muted hover:text-ink hover:border-glass-border/80',
        disabled && 'opacity-40 pointer-events-none',
      )}>
      {hasIssues && !active && <span className={cn('w-1.5 h-1.5 rounded-full', tone === 'drift' ? 'bg-amber-500' : 'bg-red-500')} />}
      {label}
      <span className={cn('tabular-nums', active ? 'opacity-90' : 'text-ink-muted/70')}>{count}</span>
    </button>
  )
}

// ── section ───────────────────────────────────────────────────────────────────

const SORT_OPTIONS: { key: AdoptionSort; label: string; short: string; desc: string; Icon: ComponentType<{ className?: string }> }[] = [
  { key: 'match', label: 'Worst match first', short: 'Worst first', desc: 'Lowest-matching sources at the top', Icon: Icons.TrendingDown },
  { key: 'issues', label: 'Most issues first', short: 'Most issues', desc: 'Most drift & unmapped types first', Icon: Icons.TriangleAlert },
  { key: 'label', label: 'Name (A–Z)', short: 'Name', desc: 'Alphabetical by data source', Icon: Icons.ArrowDownAZ },
  { key: 'freshness', label: 'Recently profiled', short: 'Recent', desc: 'Most recently scanned first', Icon: Icons.Clock },
]

/** Premium sort control — a labelled trigger + a described menu, so "worst match
 * first" reads as an explicit, understood choice rather than an opaque dropdown value. */
function SortMenu({ value, onChange }: { value: AdoptionSort; onChange: (s: AdoptionSort) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const current = SORT_OPTIONS.find(o => o.key === value) ?? SORT_OPTIONS[0]
  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated/60 text-xs hover:border-glass-border/80 transition-colors">
        <current.Icon className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
        <span className="text-ink-muted hidden sm:inline">Sort:</span>
        <span className="text-ink font-medium whitespace-nowrap">{current.short}</span>
        <Icons.ChevronDown className={cn('w-3.5 h-3.5 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="listbox"
          className="absolute right-0 mt-1.5 w-64 rounded-xl border border-glass-border bg-canvas-elevated shadow-xl shadow-black/10 dark:shadow-black/40 z-20 p-1 animate-in fade-in slide-in-from-top-1 duration-150">
          {SORT_OPTIONS.map(o => {
            const active = o.key === value
            return (
              <button key={o.key} role="option" aria-selected={active}
                onClick={() => { onChange(o.key); setOpen(false) }}
                className={cn('w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                  active ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
                <o.Icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', active ? 'text-accent-lineage' : 'text-ink-muted')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-xs font-medium', active ? 'text-accent-lineage' : 'text-ink')}>{o.label}</span>
                    {active && <Icons.Check className="w-3 h-3 text-accent-lineage" />}
                  </div>
                  <div className="text-[10px] text-ink-muted mt-0.5">{o.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface Verdict { title: string; text: string; Icon: ComponentType<{ className?: string }>; color: string }

function MiniStat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div>
      <div className="text-lg font-bold tracking-tight leading-none tabular-nums" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mt-1">{label}</div>
    </div>
  )
}

export function AdoptionMatchSection({ ontologyId }: { ontologyId: string }) {
  const [mode, setMode] = useState<Mode>('weighted')
  const [filter, setFilter] = useState<AdoptionFilter>('all')
  const [sort, setSort] = useState<AdoptionSort>('match')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [explainerOpen, setExplainerOpen] = useState(false)

  // Debounce the search box so keystrokes don't each fire a request.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any narrowing change resets to the first page.
  useEffect(() => { setOffset(0) }, [search, filter, sort])

  const { data, isLoading, isFetching, error } = useOntologyAdoption(ontologyId, {
    limit: PAGE_SIZE, offset, search, filter, sort,
  })

  const aggSeg = useMemo<Segments>(() => {
    const s = data && (mode === 'weighted' ? data.segments.weighted : data.segments.byType)
    if (!s) return { exact: 0, drift: 0, unmapped: 0, total: 0 }
    return { exact: s.exact, drift: s.drift, unmapped: s.unmapped, total: s.exact + s.drift + s.unmapped }
  }, [data, mode])
  const aggPct = data ? (mode === 'weighted' ? data.matchWeighted : data.matchByType) : 0

  if (isLoading) return (
    <div className="flex items-center justify-center py-16 text-ink-muted">
      <Icons.Loader2 className="w-5 h-5 animate-spin mr-2" />Analyzing adoption…
    </div>
  )
  if (error) return (
    <div className="flex items-center gap-2 p-4 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20 text-red-600 dark:text-red-400 text-sm">
      <Icons.AlertTriangle className="w-4 h-4" />Couldn't load adoption: {error instanceof Error ? error.message : 'unknown error'}
    </div>
  )
  if (!data || data.sourceCount === 0) return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-100 to-indigo-50 dark:from-indigo-950/40 dark:to-indigo-900/20 flex items-center justify-center mb-4">
        <Icons.Unplug className="w-6 h-6 text-indigo-500" />
      </div>
      <p className="text-sm font-medium text-ink">No data sources use this ontology yet</p>
      <p className="text-xs text-ink-muted mt-1 max-w-sm">Assign it to a data source (in the Usage section below) and, once the graph is profiled, its declared-vs-physical match will appear here.</p>
    </div>
  )

  const facets: AdoptionFacets = data.facets
  const needsAttention = Math.max(0, data.profiledCount - facets.exact)
  const from = data.total === 0 ? 0 : offset + 1
  const to = Math.min(offset + PAGE_SIZE, data.total)
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < data.total

  // Plain-language verdict — the guidance that tells the user what (if anything) to do.
  const verdict: Verdict = (() => {
    if (data.profiledCount === 0)
      return { title: 'Not profiled yet', color: 'text-ink-muted', Icon: Icons.Clock,
        text: `${plural(data.sourceCount, 'source')} assigned, but none have been scanned by the insights service yet. Match appears after the first profile.` }
    if (data.driftTypeCount === 0 && data.unmappedTypeCount === 0)
      return { title: 'Fully aligned', color: 'text-emerald-500', Icon: Icons.ShieldCheck,
        text: `Every profiled source matches the ontology exactly — all types are hitting FalkorDB's labels and indices. Nothing to fix.` }
    const parts: string[] = []
    if (data.driftTypeCount > 0) parts.push(plural(data.driftTypeCount, 'case-drifted type'))
    if (data.unmappedTypeCount > 0) parts.push(plural(data.unmappedTypeCount, 'unmapped type'))
    return {
      title: 'Needs attention',
      color: data.unmappedTypeCount > 0 ? 'text-red-500' : 'text-amber-500',
      Icon: Icons.TriangleAlert,
      text: `${parts.join(' and ')} across ${plural(needsAttention, 'source')}. Drifted types are present but spelled differently than declared, so they bypass FalkorDB's indices — align the casing to fix. Filter below to jump to the flagged sources.`,
    }
  })()

  return (
    <div className="space-y-4">
      {/* collapsible educational strip — guidance without permanent clutter */}
      <div className="rounded-xl border border-glass-border bg-canvas-elevated/30 overflow-hidden">
        <button onClick={() => setExplainerOpen(o => !o)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
          <Icons.ScanSearch className="w-4 h-4 text-indigo-500 flex-shrink-0" />
          <span className="text-xs font-medium text-ink flex-1">How does adoption matching work?</span>
          <Icons.ChevronDown className={cn('w-4 h-4 text-ink-muted transition-transform', explainerOpen && 'rotate-180')} />
        </button>
        {explainerOpen && (
          <div className="px-3.5 pb-3.5 pt-1 space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
            <p className="text-xs text-ink-secondary leading-relaxed">
              Your ontology declares the types; the physical graph in FalkorDB is what's actually stored. Those declared names are
              exactly what nodes and edges become when a versioned graph is built:
            </p>
            <DeclaredVsPhysical footer={false} />
            <p className="text-xs text-ink-secondary leading-relaxed">
              This tab compares each source's profiled graph against the declared types.
              <span className="text-emerald-600 dark:text-emerald-400 font-medium"> Exact</span> types match the declared spelling and hit FalkorDB's labels/indices;
              <span className="text-amber-600 dark:text-amber-400 font-medium"> case drift</span> is present-but-wrong-casing, so it silently misses them;
              <span className="text-red-600 dark:text-red-400 font-medium"> unmapped</span> types aren't classified by the ontology at all.
              It reads from cached profiling stats — no live graph queries — so it stays fast at hundreds of sources.
            </p>
          </div>
        )}
      </div>

      {/* hero: ring + plain-language verdict + mini stats */}
      <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Overall adoption</span>
            <Legend />
          </div>
          <div className="inline-flex items-center rounded-lg bg-black/[0.04] dark:bg-white/[0.05] p-0.5 text-[11px] font-medium">
            {(['weighted', 'by-type'] as Mode[]).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={cn('px-2.5 py-1 rounded-md transition-colors',
                  mode === m ? 'bg-accent-lineage/12 text-accent-lineage' : 'text-ink-muted hover:text-ink')}>
                {m === 'weighted' ? 'By volume' : 'By type'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-start gap-5">
          <MatchRing seg={aggSeg} pct={aggPct} size={100} stroke={11} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <verdict.Icon className={cn('w-4 h-4', verdict.color)} />
              <span className="text-base font-semibold text-ink">{verdict.title}</span>
            </div>
            <p className="text-xs text-ink-secondary mt-1 leading-relaxed">{verdict.text}</p>
            <div className="flex items-center gap-6 mt-4">
              <MiniStat label="Profiled" value={`${data.profiledCount}/${data.sourceCount}`} />
              <MiniStat label="Case drift" value={data.driftTypeCount} tone={data.driftTypeCount ? SEG.drift : undefined} />
              <MiniStat label="Unmapped" value={data.unmappedTypeCount} tone={data.unmappedTypeCount ? SEG.unmapped : undefined} />
            </div>
          </div>
        </div>
      </div>

      {/* per-source list */}
      <div>
        {/* controls: search + sort */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-0">
            <Icons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search data source or workspace…"
              className="w-full pl-8 pr-8 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated/60 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent-lineage/40 focus:border-accent-lineage/40 transition-shadow"
            />
            {searchInput && (
              <button onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                <Icons.X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <SortMenu value={sort} onChange={setSort} />
        </div>

        {/* filter chips with facet counts */}
        <div className="flex items-center flex-wrap gap-1.5 mb-3">
          {FILTERS.map(f => (
            <FacetChip key={f.key} label={f.label} tone={f.tone} count={facets[f.key]}
              active={filter === f.key} onClick={() => setFilter(f.key)} />
          ))}
        </div>

        {/* results */}
        {data.total === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center rounded-xl border border-dashed border-glass-border">
            <Icons.SearchX className="w-6 h-6 text-ink-muted/50 mb-2" />
            <p className="text-sm text-ink-muted">No data sources match these filters</p>
            {(filter !== 'all' || search) && (
              <button onClick={() => { setFilter('all'); setSearchInput('') }}
                className="mt-2 text-xs text-accent-lineage hover:underline">Clear filters</button>
            )}
          </div>
        ) : (
          <div className={cn('space-y-2 transition-opacity', isFetching && 'opacity-60')}>
            {data.sources.map((s, i) => <SourceRow key={s.dataSourceId} src={s} mode={mode} index={i} />)}
          </div>
        )}

        {/* pagination */}
        {data.total > 0 && (
          <div className="flex items-center justify-between mt-3 px-1">
            <span className="text-[11px] text-ink-muted tabular-nums">
              Showing <span className="text-ink font-medium">{from}–{to}</span> of {data.total}
              {data.total !== data.sourceCount && <span className="text-ink-muted"> · {data.sourceCount} total</span>}
            </span>
            {(canPrev || canNext) && (
              <div className="inline-flex items-center gap-1">
                <button disabled={!canPrev} onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-glass-border text-[11px] text-ink-muted hover:text-ink hover:border-glass-border/80 disabled:opacity-40 disabled:pointer-events-none transition-colors">
                  <Icons.ChevronLeft className="w-3.5 h-3.5" />Prev
                </button>
                <button disabled={!canNext} onClick={() => setOffset(o => o + PAGE_SIZE)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-glass-border text-[11px] text-ink-muted hover:text-ink hover:border-glass-border/80 disabled:opacity-40 disabled:pointer-events-none transition-colors">
                  Next<Icons.ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
