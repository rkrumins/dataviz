/**
 * CascadeImpactList — the full, itemised breakdown of what a delete will remove: every
 * contained entity + every incident relationship (the backend's delete-impact preview).
 * Shown in the staged-changes review so a business user sees the exact blast radius of
 * deleting, say, a Domain — before committing. Lists are capped for sanity ("+N more").
 */
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NodeDiffBadge, STATUS_META } from './NodeDiffBadge'

interface ImpactEntity {
  entityId?: string
  urn?: string
  displayName?: string
  entityType?: string
  edgeType?: string
  sourceEntityId?: string
  targetEntityId?: string
  [k: string]: unknown
}

export interface CascadeImpact {
  nodes: ImpactEntity[]
  edges: ImpactEntity[]
  nodeTotal: number
  edgeTotal: number
}

const short = (id?: string) => {
  const s = String(id ?? '')
  return s.length > 30 ? `…${s.slice(-28)}` : s || '—'
}

export function CascadeImpactList({ impact, rootUrn }: { impact: CascadeImpact; rootUrn?: string }) {
  if (impact.nodeTotal <= 1 && impact.edgeTotal === 0) return null
  const childNodes = impact.nodes.filter((n) => (n.urn ?? n.entityId) !== rootUrn)
  const moreNodes = impact.nodeTotal - impact.nodes.length
  const moreEdges = impact.edgeTotal - impact.edges.length
  // A relationship's ends by name where the impact lists them (the entities going with it).
  const names = new Map<string, string>()
  for (const n of impact.nodes) {
    const name = n.displayName ? String(n.displayName) : undefined
    if (!name) continue
    if (n.entityId) names.set(String(n.entityId), name)
    if (n.urn) names.set(String(n.urn), name)
  }
  const nameOf = (id?: string) => (id && names.get(id)) || short(id)

  return (
    <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-2.5 space-y-2.5">
      <p className="text-[11px] text-ink-muted">
        Also removes{' '}
        <span className="font-semibold text-rose-500 tabular-nums">{Math.max(0, impact.nodeTotal - 1)}</span>{' '}
        contained {impact.nodeTotal === 2 ? 'entity' : 'entities'} and{' '}
        <span className="font-semibold text-rose-500 tabular-nums">{impact.edgeTotal}</span>{' '}
        relationship{impact.edgeTotal === 1 ? '' : 's'}.
      </p>

      {childNodes.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-1">Entities</p>
          <ul className="space-y-0.5 max-h-44 overflow-y-auto">
            {childNodes.map((n) => (
              <li key={String(n.entityId ?? n.urn)} className="flex items-center gap-2 text-[12px]">
                <NodeDiffBadge status="removed" />
                <span className={cn('text-ink truncate', STATUS_META.removed.strike)} title={String(n.urn ?? n.entityId)}>
                  {String(n.displayName ?? n.urn ?? n.entityId)}
                </span>
                {n.entityType && <span className="text-[10px] text-ink-muted shrink-0">· {String(n.entityType)}</span>}
              </li>
            ))}
            {moreNodes > 0 && <li className="text-[11px] text-ink-muted/80 pl-1">+ {moreNodes} more…</li>}
          </ul>
        </div>
      )}

      {impact.edges.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-1">Relationships</p>
          <ul className="space-y-0.5 max-h-44 overflow-y-auto">
            {impact.edges.map((e) => (
              <li key={String(e.entityId)} className="flex items-center gap-1.5 text-[11px] text-ink-muted min-w-0">
                <NodeDiffBadge status="removed" />
                <span className="font-medium text-ink/80 shrink-0">{String(e.edgeType ?? 'edge')}</span>
                <span className={cn('truncate', STATUS_META.removed.strike)} title={String(e.sourceEntityId ?? '')}>{nameOf(e.sourceEntityId)}</span>
                <ArrowRight className="w-3 h-3 shrink-0" />
                <span className={cn('truncate', STATUS_META.removed.strike)} title={String(e.targetEntityId ?? '')}>{nameOf(e.targetEntityId)}</span>
              </li>
            ))}
            {moreEdges > 0 && <li className="text-[11px] text-ink-muted/80 pl-1">+ {moreEdges} more…</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
