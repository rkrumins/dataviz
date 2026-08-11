/**
 * SCRATCH — not part of the suite, not for commit.
 *
 * Renders `buildFocusGraph`'s output geometry as an SVG so a human can
 * LOOK at it. Three rounds of layout work shipped on numeric assertions
 * alone (`encloses(outer, inner)`), which are blind to anything that is
 * structurally right and visually wrong.
 *
 *   npx vitest run src/components/canvas/context-view/lens/__tests__/geometry-plot.scratch.ts
 */
import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { deriveNeighborRecords } from '@/lib/lineage-neighbors'
import { buildFocusGraph, type FocusGraphInput, type FocusCard } from '../focus-graph'

const OUT = '/tmp/claude-0/-home-user-dataviz/8613de2e-82b1-5839-8ee0-5ccc23135661/scratchpad/harness'

const node = (id: string, type = 'dataset'): LineageNode => ({
  id, type: 'custom', position: { x: 0, y: 0 },
  data: { label: id, type, urn: id },
} as unknown as LineageNode)

const edge = (id: string, source: string, target: string, data: Record<string, unknown> = {}): LineageEdge =>
  ({ id, source, target, data: { edgeType: 'FLOWS_TO', ...data } } as unknown as LineageEdge)

const contains = (id: string, p: string, c: string): LineageEdge => edge(id, p, c, { edgeType: 'CONTAINS' })

function build(opts: {
  nodes: LineageNode[]; edges: LineageEdge[]
  isCoarser?: (t: string | undefined, base: string) => boolean
  canContain?: (t: string | undefined) => boolean
  over?: Partial<FocusGraphInput>
}) {
  const focalId = 'F'
  const nodeMap = new Map(opts.nodes.map(n => [n.id, n]))
  const byEnd = new Map<string, LineageEdge[]>()
  for (const e of opts.edges) for (const k of e.source === e.target ? [e.source] : [e.source, e.target]) {
    const l = byEnd.get(k); if (l) l.push(e); else byEnd.set(k, [e])
  }
  const { incomingRecords, outgoingRecords } = deriveNeighborRecords(focalId, byEnd.get(focalId) ?? [], nodeMap, ['CONTAINS'])
  const containsChildren: string[] = []
  for (const e of byEnd.get(focalId) ?? []) {
    if (e.source === focalId && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') containsChildren.push(e.target)
  }
  return buildFocusGraph({
    focalId, incomingRecords, outgoingRecords, edgesByEndpoint: byEnd, nodeMap,
    containmentEdgeTypes: ['CONTAINS'], containsChildren,
    resolveParent: (id) => {
      for (const e of byEnd.get(id) ?? []) {
        if (e.target === id && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') return e.source
      }
      return null
    },
    isCoarser: opts.isCoarser ?? (() => false),
    canContain: opts.canContain ?? (() => false),
    expandedGroups: new Set(), expandedFrontier: new Set(), openContainers: new Set(),
    entityLevels: new Map([['CONTAINER', 2], ['DATAPLATFORM', 1], ['dataset', 3], ['schemaField', 4]]),
    bandPages: new Map(), query: '', hiddenTypes: new Set(),
    ...opts.over,
  })
}

const FILL: Record<string, string> = {
  focal: '#6366f1', entity: '#0ea5e9', group: '#8b5cf6',
  contains: '#14b8a6', overflow: '#94a3b8', frame: 'none',
}

/** Overlap between two cards that are NOT in a frame/child relationship. */
function overlaps(a: FocusCard, b: FocusCard): boolean {
  if (a.frameId === b.id || b.frameId === a.id) return false      // nesting is fine
  if (a.frameId && a.frameId === b.frameId) { /* siblings: must not overlap */ }
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function plot(name: string, g: ReturnType<typeof build>) {
  const cards = g.cards
  const minX = Math.min(...cards.map(c => c.x)) - 40
  const minY = Math.min(...cards.map(c => c.y)) - 40
  const maxX = Math.max(...cards.map(c => c.x + c.w)) + 40
  const maxY = Math.max(...cards.map(c => c.y + c.h)) + 40

  // Anything wrong, marked in red on the picture itself.
  const bad = new Set<string>()
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j]
      if (a.kind === 'frame' || b.kind === 'frame') continue
      if (overlaps(a, b)) { bad.add(a.id); bad.add(b.id) }
    }
  }
  const frameIds = new Set(cards.filter(c => c.kind === 'frame').map(c => c.id))
  for (const c of cards) if (c.frameId && !frameIds.has(c.frameId)) bad.add(c.id)   // orphan
  for (const c of cards) {
    if (!c.frameId) continue
    const f = cards.find(x => x.id === c.frameId)
    if (!f) continue
    const inside = c.x >= f.x && c.y >= f.y && c.x + c.w <= f.x + f.w && c.y + c.h <= f.y + f.h
    if (!inside) { bad.add(c.id); bad.add(f.id) }                                   // escapes its frame
  }

  const body = cards.map(c => {
    const stroke = bad.has(c.id) ? '#dc2626' : c.kind === 'frame' ? '#6366f1' : '#33415580'
    const sw = bad.has(c.id) ? 3 : c.kind === 'frame' ? 2 : 1
    const dash = c.kind === 'frame' ? ' stroke-dasharray="6 4"' : ''
    return `  <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="8"`
      + ` fill="${FILL[c.kind] ?? '#cbd5e1'}${c.kind === 'frame' ? '' : '22'}"`
      + ` stroke="${stroke}" stroke-width="${sw}"${dash} />\n`
      + `  <text x="${c.x + 6}" y="${c.y + 15}" font-family="ui-monospace,monospace" font-size="10" fill="#0f172a">`
      + `${c.label.slice(0, 30)}</text>\n`
      + `  <text x="${c.x + 6}" y="${c.y + 27}" font-family="ui-monospace,monospace" font-size="8" fill="#64748b">`
      + `${c.kind}${c.depth ? ` d${c.depth}` : ''}${c.canOpenChildren ? ' [v]' : ''}${c.expandKind ? ` ${c.expandKind}` : ''}</text>`
  }).join('\n')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="${maxX - minX}" height="${maxY - minY}">
  <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#f8fafc" />
${body}
  <text x="${minX + 8}" y="${minY + 20}" font-family="ui-sans-serif" font-size="14" fill="#0f172a">${name} — ${cards.length} cards, ${bad.size} flagged</text>
</svg>`
  writeFileSync(`${OUT}/${name}.svg`, svg)
  // eslint-disable-next-line no-console
  console.log(`${name}: ${cards.length} cards, ${bad.size} FLAGGED${bad.size ? ` -> ${[...bad].join(', ')}` : ''}`)
}

describe('geometry plot (scratch)', () => {
  it('plots the shapes that matter', () => {
    plot('01-plain', build({
      nodes: [node('F'), node('up_a'), node('up_b'), node('down_a')],
      edges: [edge('e1', 'up_a', 'F'), edge('e2', 'up_b', 'F'), edge('e3', 'F', 'down_a')],
    }))

    const kids = Array.from({ length: 25 }, (_, i) => node(`col_${String(i).padStart(2, '0')}`))
    plot('02-frame-all-paged', build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), ...kids],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        frameShowAll: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [kids[0]], edges: [edge('r0', kids[0].id, 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
        frameAllResults: new Map([['in:Snowflake', { children: kids, hasMore: false, total: 25 }]]),
        frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    }))

    plot('03-nested-frames', build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('tbl', 'CONTAINER'), node('col_x'), node('col_y')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      canContain: (t) => t === 'CONTAINER' || t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake', 'in:tbl']),
        containerResults: new Map([
          ['in:Snowflake', { nodes: [node('tbl', 'CONTAINER')], edges: [edge('r1', 'tbl', 'F')], passedThrough: [], truncated: false, empty: false }],
          ['in:tbl', { nodes: [node('col_x'), node('col_y')], edges: [edge('r2', 'col_x', 'F'), edge('r3', 'col_y', 'F')], passedThrough: [], truncated: false, empty: false }],
        ]),
        containerStatus: new Map([['in:Snowflake', 'done' as const], ['in:tbl', 'done' as const]]),
      },
    }))

    const chain = ['lvl0', 'lvl1', 'lvl2', 'lvl3']
    plot('04-contains-tree', build({
      nodes: [node('F'), ...chain.map(c => node(c))],
      edges: [contains('c1', 'F', 'lvl0')],
      canContain: () => true,
      over: {
        bandPages: new Map([['contains', 1]]),
        openContains: new Set(chain),
        containsChildrenOf: new Map([['lvl0', ['lvl1']], ['lvl1', ['lvl2']], ['lvl2', ['lvl3']]]),
        containsStatusOf: new Map(chain.map(c => [c, 'done' as const])),
      },
    }))

    // The shape the audit said could orphan cards onto the focal.
    plot('05-frame-owns-shared-child', build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('shared')],
      edges: [edge('e1', 'Snowflake', 'F'), edge('e2', 'shared', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('shared')], edges: [edge('r1', 'shared', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    }))
  })
})
