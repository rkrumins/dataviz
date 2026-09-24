/**
 * SubsetPreviewDiagram — the subset as it will read, at a glance: its layers
 * left to right, its entities in them, direct lineage as plain lines and
 * virtual hops as the stitched accent line the view itself will draw.
 *
 * Every entity is drawn while there are few enough to tell apart; past that
 * each layer is one block with its count, and the lines between two layers
 * merge into one that carries how many of each kind it stands for.
 */
import { useMemo } from 'react'

import { VIRTUAL_HOP_COLOR, VIRTUAL_HOP_DASH } from '@/components/canvas/context-view/edgeDash'
import type { LineageBridgeLink } from '@/providers/GraphDataProvider'

import type { SubsetPick } from '../../model/studioStore'
import type { StudioLayer } from './atoms'

/** Above this many picks, layers draw as blocks. */
export const DIAGRAM_DETAIL_MAX = 40

const W = 360
const EDGE = 10
const PAD_TOP = 30
const PAD_BOTTOM = 16
const ROW = 22
const CHAR_W = 4.6
/** A background-coloured outline behind text, so a line crossing a name
 *  never makes it unreadable. */
const HALO = { stroke: 'var(--nx-bg-elevated)', strokeWidth: 3, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const }

function fit(text: string, room: number): string {
  const chars = Math.max(3, Math.floor(room / CHAR_W))
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

export function SubsetPreviewDiagram({ layers, picks, links }: {
  layers: readonly StudioLayer[]
  picks: readonly SubsetPick[]
  links: readonly LineageBridgeLink[]
}) {
  const shownLayers = useMemo(() => {
    const used = new Set(picks.map(p => p.layerId))
    return layers.filter(l => used.has(l.id))
  }, [layers, picks])
  const n = shownLayers.length
  // Columns sit inside the frame, leaving the outer side of the first and
  // last for their headers.
  const inset = 28
  const colX = (i: number) => (n <= 1 ? W / 2 : inset + (i * (W - inset * 2)) / (n - 1))
  const spacing = n <= 1 ? W - EDGE * 2 : (W - inset * 2) / (n - 1)
  const detailed = picks.length <= DIAGRAM_DETAIL_MAX
  const tallest = useMemo(() => {
    const per = new Map<string, number>()
    for (const p of picks) per.set(p.layerId, (per.get(p.layerId) ?? 0) + 1)
    return Math.max(1, ...per.values())
  }, [picks])
  const H = detailed
    ? Math.min(260, Math.max(110, PAD_TOP + (tallest - 1) * ROW + PAD_BOTTOM + 12))
    : 160
  const direct = links.filter(l => l.hops <= 1).length
  const virtual = links.length - direct
  const label = `Preview: ${picks.length} entities in ${n} layers, `
    + `${direct} direct links and ${virtual} virtual hops`

  if (n === 0) return null

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="w-full h-auto rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] text-ink-muted"
    >
      {shownLayers.map((l, i) => {
        const first = i === 0 && n > 1
        const last = i === n - 1 && n > 1
        return (
          <text
            key={l.id}
            x={first ? EDGE : last ? W - EDGE : colX(i)}
            y={16}
            textAnchor={first ? 'start' : last ? 'end' : 'middle'}
            fontSize="9"
            fontWeight={600}
            fill="currentColor"
          >
            {fit(l.name, first || last ? spacing * 0.9 : spacing - 8)}
          </text>
        )
      })}
      {detailed
        ? <DetailedBody layers={shownLayers} picks={picks} links={links} colX={colX} spacing={spacing} height={H} />
        : <BlockBody layers={shownLayers} picks={picks} links={links} colX={colX} />}
    </svg>
  )
}

function DetailedBody({ layers, picks, links, colX, spacing, height }: {
  layers: readonly StudioLayer[]
  picks: readonly SubsetPick[]
  links: readonly LineageBridgeLink[]
  colX: (i: number) => number
  spacing: number
  height: number
}) {
  const pos = useMemo(() => {
    const out = new Map<string, { x: number; y: number; color?: string; column: number }>()
    layers.forEach((l, i) => {
      const inLayer = picks.filter(p => p.layerId === l.id)
      const span = height - PAD_TOP - PAD_BOTTOM
      const top = PAD_TOP + (span - ROW * (inLayer.length - 1)) / 2
      inLayer.forEach((p, j) => out.set(p.urn, { x: colX(i), y: top + j * ROW, color: l.color, column: i }))
    })
    return out
  }, [layers, picks, colX, height])
  // Names beside the dots only when a column leaves room for them. The last
  // column names its entities on its left, so it and its neighbour share
  // the gap between them.
  const labelRoom = spacing - 16
  const labelled = labelRoom >= 40
  const lastColumn = layers.length - 1
  const roomFor = (column: number) =>
    lastColumn > 0 && (column === lastColumn || column === lastColumn - 1) ? labelRoom / 2 : labelRoom

  return (
    <g>
      {links.map(l => {
        const a = pos.get(l.source)
        const b = pos.get(l.target)
        if (!a || !b) return null
        const virtual = l.hops >= 2
        const mx = (a.x + b.x) / 2
        return (
          <path
            key={`${l.source}|${l.target}`}
            d={`M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`}
            fill="none"
            stroke={virtual ? VIRTUAL_HOP_COLOR : 'currentColor'}
            strokeOpacity={virtual ? 0.9 : 0.45}
            strokeWidth={virtual ? 1.4 : 1}
            strokeDasharray={virtual ? VIRTUAL_HOP_DASH : undefined}
            strokeLinecap="round"
          />
        )
      })}
      {picks.map(p => {
        const at = pos.get(p.urn)
        if (!at) return null
        return (
          <g key={p.urn}>
            <circle
              cx={at.x} cy={at.y} r={4.5}
              style={{ fill: 'var(--nx-bg-elevated)' }}
              stroke={at.color ?? VIRTUAL_HOP_COLOR}
              strokeWidth={2}
              strokeDasharray={p.origin === 'outside' ? '2 2' : undefined}
            />
            {labelled && (
              <text
                x={at.column === lastColumn && lastColumn > 0 ? at.x - 8 : at.x + 8}
                y={at.y + 3}
                textAnchor={at.column === lastColumn && lastColumn > 0 ? 'end' : 'start'}
                fontSize="8"
                fill="currentColor"
                {...HALO}
              >
                {fit(p.label, roomFor(at.column))}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

function BlockBody({ layers, picks, links, colX }: {
  layers: readonly StudioLayer[]
  picks: readonly SubsetPick[]
  links: readonly LineageBridgeLink[]
  colX: (i: number) => number
}) {
  const layerOf = useMemo(() => new Map(picks.map(p => [p.urn, p.layerId])), [picks])
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const p of picks) c.set(p.layerId, (c.get(p.layerId) ?? 0) + 1)
    return c
  }, [picks])
  const pairs = useMemo(() => {
    const m = new Map<string, { a: string; b: string; direct: number; virtual: number }>()
    for (const l of links) {
      const a = layerOf.get(l.source)
      const b = layerOf.get(l.target)
      if (!a || !b || a === b) continue
      const key = `${a}|${b}`
      const pair = m.get(key) ?? { a, b, direct: 0, virtual: 0 }
      if (l.hops >= 2) pair.virtual++
      else pair.direct++
      m.set(key, pair)
    }
    return [...m.values()]
  }, [links, layerOf])
  const index = new Map(layers.map((l, i) => [l.id, i]))
  const blockY = PAD_TOP + 14
  const blockH = 70

  return (
    <g>
      {pairs.map(pair => {
        const ia = index.get(pair.a)
        const ib = index.get(pair.b)
        if (ia === undefined || ib === undefined) return null
        const ax = colX(ia)
        const bx = colX(ib)
        const y = blockY + blockH / 2 + (ia < ib ? -8 : 8)
        const virtual = pair.virtual > 0
        return (
          <g key={`${pair.a}|${pair.b}`}>
            <path
              d={`M ${ax} ${y} L ${bx} ${y}`}
              stroke={virtual ? VIRTUAL_HOP_COLOR : 'currentColor'}
              strokeOpacity={virtual ? 0.9 : 0.45}
              strokeWidth={1 + Math.min(3, Math.log2(pair.direct + pair.virtual + 1))}
              strokeDasharray={virtual ? VIRTUAL_HOP_DASH : undefined}
              strokeLinecap="round"
            />
            <text x={(ax + bx) / 2} y={y - 5} textAnchor="middle" fontSize="8.5" fill="currentColor" {...HALO}>
              {pair.direct > 0 ? `${pair.direct} direct` : ''}{pair.direct > 0 && virtual ? ' · ' : ''}{virtual ? `${pair.virtual} via` : ''}
            </text>
          </g>
        )
      })}
      {layers.map((l, i) => (
        <g key={l.id}>
          <rect
            x={colX(i) - 22} y={blockY} width={44} height={blockH} rx={10}
            style={{ fill: 'var(--nx-bg-elevated)' }}
            stroke={l.color ?? 'currentColor'}
            strokeWidth={1.5}
          />
          <text x={colX(i)} y={blockY + blockH / 2 + 4} textAnchor="middle" fontSize="12" fontWeight={700} fill="currentColor">
            {(counts.get(l.id) ?? 0).toLocaleString()}
          </text>
        </g>
      ))}
    </g>
  )
}
