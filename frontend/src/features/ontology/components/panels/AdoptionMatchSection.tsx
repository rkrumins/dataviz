/**
 * AdoptionMatchSection — how well each data source's PHYSICAL graph matches this
 * ontology's DECLARED types, from the periodic profiling stats.
 *
 * Every physical node/edge type is classified:
 *   exact     (emerald) — declared with identical casing → hitting FalkorDB labels/indices
 *   case drift (amber)  — present but wrong casing (physical `has` vs declared `HAS`)
 *   unmapped   (red)    — the ontology doesn't classify it
 *
 * Match % is the correctly-classified (exact) share, shown instance-weighted or by-type.
 */
import { useMemo, useState, type ReactNode, type ComponentType } from 'react'
import * as Icons from 'lucide-react'
import { useOntologyAdoption } from '../../hooks/useOntologies'
import type {
  AdoptionDimension,
  AdoptionSource,
} from '@/services/ontologyDefinitionService'
import { formatCount } from '../../lib/ontology-parsers'
import { cn } from '@/lib/utils'

type Mode = 'weighted' | 'by-type'

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

function matchColor(pct: number): string {
  return pct >= 99.95 ? SEG.exact : pct >= 75 ? SEG.drift : SEG.unmapped
}

// ── multi-segment ring ────────────────────────────────────────────────────────

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
        <span className="font-bold tracking-tight text-ink leading-none"
          style={{ fontSize: size * 0.26 }}>{Math.round(pct)}<span className="text-[0.5em]">%</span></span>
      </div>
    </div>
  )
}

function Legend() {
  const items: [string, string][] = [['Exact', SEG.exact], ['Case drift', SEG.drift], ['Unmapped', SEG.unmapped]]
  return (
    <div className="flex items-center gap-3">
      {items.map(([label, color]) => (
        <span key={label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />{label}
        </span>
      ))}
    </div>
  )
}

// ── type-breakdown chips (expanded row) ───────────────────────────────────────

function DimBreakdown({ title, dim }: { title: string; dim: AdoptionDimension | null }) {
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

// ── per-source row ────────────────────────────────────────────────────────────

function SourceRow({ src, mode, index }: { src: AdoptionSource; mode: Mode; index: number }) {
  const [open, setOpen] = useState(false)
  const seg = segmentsOf([src.nodes, src.edges], mode)
  const pct = (mode === 'weighted' ? src.matchWeighted : src.matchByType) ?? 0
  const stale = src.profiled && !!src.schemaUpdatedAt && (Date.now() - Date.parse(src.schemaUpdatedAt)) > 24 * 3600 * 1000
  const driftN = (src.nodes?.caseDrift.length ?? 0) + (src.edges?.caseDrift.length ?? 0)
  const unmapN = (src.nodes?.unmapped.length ?? 0) + (src.edges?.unmapped.length ?? 0)
  const exactN = (src.nodes?.exact.length ?? 0) + (src.edges?.exact.length ?? 0)

  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 overflow-hidden animate-in fade-in slide-in-from-bottom-1"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationFillMode: 'backwards' }}>
      <button onClick={() => src.profiled && setOpen(o => !o)}
        className={cn('w-full flex items-center gap-4 p-3.5 text-left transition-colors',
          src.profiled ? 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]' : 'cursor-default')}>
        {src.profiled
          ? <MatchRing seg={seg} pct={pct} size={54} stroke={6} />
          : <div className="w-[54px] h-[54px] rounded-full border-2 border-dashed border-glass-border flex items-center justify-center flex-shrink-0">
              <Icons.CircleDashed className="w-5 h-5 text-ink-muted/50" /></div>}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-ink truncate">{src.dataSourceLabel}</span>
            <span className="text-[11px] text-ink-muted truncate">· {src.workspaceName}</span>
          </div>
          {src.profiled ? (
            <div className="flex items-center gap-2.5 mt-1 text-[11px] flex-wrap">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">{exactN} exact</span>
              {driftN > 0 && <span className="text-amber-600 dark:text-amber-400 font-medium">{driftN} drift</span>}
              {unmapN > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{unmapN} unmapped</span>}
              <span className="inline-flex items-center gap-1 text-ink-muted">
                <Icons.Clock className="w-3 h-3" />profiled {timeAgo(src.schemaUpdatedAt)}
                {stale && <span className="ml-1 px-1.5 py-px rounded bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400">stale</span>}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-ink-muted italic mt-1">Awaiting first profile — the insights service hasn't scanned this graph yet.</p>
          )}
        </div>

        {src.profiled && (
          <Icons.ChevronDown className={cn('w-4 h-4 text-ink-muted/50 transition-transform flex-shrink-0', open && 'rotate-180')} />
        )}
      </button>

      {open && src.profiled && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-glass-border/60 bg-black/[0.015] dark:bg-white/[0.015] animate-in fade-in slide-in-from-top-1 duration-200">
          {driftN > 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
              <Icons.TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
              Case drift means the physical type is present but spelled differently than declared — FalkorDB is case-sensitive, so it won't hit the label/index. Align the casing (declared or physical) to fix.
            </p>
          )}
          <DimBreakdown title="Node types" dim={src.nodes} />
          <DimBreakdown title="Edge types" dim={src.edges} />
        </div>
      )}
    </div>
  )
}

// ── section ───────────────────────────────────────────────────────────────────

export function AdoptionMatchSection({ ontologyId }: { ontologyId: string }) {
  const { data, isLoading, error } = useOntologyAdoption(ontologyId)
  const [mode, setMode] = useState<Mode>('weighted')
  const [sort, setSort] = useState<'match' | 'drift'>('match')

  const sources = useMemo(() => {
    const list = [...(data?.sources ?? [])]
    list.sort((a, b) => {
      if (!a.profiled && b.profiled) return 1
      if (a.profiled && !b.profiled) return -1
      if (sort === 'drift') {
        const d = (s: AdoptionSource) => (s.nodes?.caseDrift.length ?? 0) + (s.edges?.caseDrift.length ?? 0) + (s.nodes?.unmapped.length ?? 0) + (s.edges?.unmapped.length ?? 0)
        return d(b) - d(a)
      }
      return ((a.matchWeighted ?? 101) - (b.matchWeighted ?? 101))  // worst match first
    })
    return list
  }, [data, sort])

  const aggSeg = useMemo(() => segmentsOf(
    (data?.sources ?? []).flatMap(s => [s.nodes, s.edges]), mode), [data, mode])
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

  return (
    <div className="space-y-5">
      {/* explainer */}
      <div className="rounded-xl border border-glass-border bg-gradient-to-br from-indigo-50/40 to-transparent dark:from-indigo-950/20 p-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center flex-shrink-0">
            <Icons.ScanSearch className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Declared vs. physical adoption</p>
            <p className="text-xs text-ink-secondary mt-0.5 leading-relaxed">
              For each data source using this ontology, we compare its profiled graph against the declared types.
              <span className="text-emerald-600 dark:text-emerald-400 font-medium"> Exact</span> types hit FalkorDB's labels/indices;
              <span className="text-amber-600 dark:text-amber-400 font-medium"> case drift</span> is present-but-wrong-casing (won't hit them);
              <span className="text-red-600 dark:text-red-400 font-medium"> unmapped</span> types aren't classified by the ontology.
            </p>
          </div>
        </div>
      </div>

      {/* aggregate hero */}
      <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Overall adoption</span>
            <Legend />
          </div>
          {/* weighting toggle */}
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
        <div className="flex items-center gap-6">
          <MatchRing seg={aggSeg} pct={aggPct} size={104} stroke={11} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
            <HeroStat icon={Icons.Target} label="Match" value={`${Math.round(aggPct)}%`} color={matchColor(aggPct)} />
            <HeroStat icon={Icons.Database} label="Sources" value={`${data.profiledCount}/${data.sourceCount}`} sub="profiled" />
            <HeroStat icon={Icons.TriangleAlert} label="Case drift" value={String(data.driftTypeCount)} color={data.driftTypeCount ? SEG.drift : undefined} />
            <HeroStat icon={Icons.CircleHelp} label="Unmapped" value={String(data.unmappedTypeCount)} color={data.unmappedTypeCount ? SEG.unmapped : undefined} />
          </div>
        </div>
      </div>

      {/* per-source list */}
      <div>
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">By data source ({data.sourceCount})</span>
          <div className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
            <span>Sort:</span>
            {(['match', 'drift'] as const).map(s => (
              <button key={s} onClick={() => setSort(s)}
                className={cn('px-1.5 py-0.5 rounded transition-colors', sort === s ? 'text-accent-lineage font-medium' : 'hover:text-ink')}>
                {s === 'match' ? 'worst match' : 'most issues'}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {sources.map((s, i) => <SourceRow key={s.dataSourceId} src={s} mode={mode} index={i} />)}
        </div>
      </div>
    </div>
  )
}

function HeroStat({ icon: Icon, label, value, sub, color }: {
  icon: ComponentType<{ className?: string }>; label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated/60 p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3.5 h-3.5 text-ink-muted" />
        <span className="text-[10px] text-ink-muted uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="text-xl font-bold tracking-tight leading-none" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[10px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  )
}
