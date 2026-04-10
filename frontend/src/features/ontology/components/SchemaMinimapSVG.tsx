/**
 * SchemaMinimapSVG — compact visual showing entity types as colored circles
 * connected by relationship arcs. Gives an at-a-glance schema topology.
 */
import { useMemo } from 'react'

interface SchemaMinimapSVGProps {
  entityTypes: Array<{ id: string; name: string; color: string }>
  relationships: Array<{ source: string; target: string; name: string }>
  maxNodes?: number
}

interface LayoutNode {
  id: string
  name: string
  color: string
  x: number
  y: number
}

export function SchemaMinimapSVG({
  entityTypes,
  relationships,
  maxNodes = 10,
}: SchemaMinimapSVGProps) {
  const { nodes, edges, overflow } = useMemo(() => {
    // Score nodes by connectivity
    const connectionCount = new Map<string, number>()
    for (const et of entityTypes) connectionCount.set(et.id, 0)
    for (const rel of relationships) {
      connectionCount.set(rel.source, (connectionCount.get(rel.source) ?? 0) + 1)
      connectionCount.set(rel.target, (connectionCount.get(rel.target) ?? 0) + 1)
    }

    // Sort by connectivity, take top N
    const sorted = [...entityTypes].sort((a, b) =>
      (connectionCount.get(b.id) ?? 0) - (connectionCount.get(a.id) ?? 0)
    )
    const visible = sorted.slice(0, maxNodes)
    const visibleIds = new Set(visible.map(v => v.id))
    const overflow = entityTypes.length - visible.length

    // Layout: arrange in a circle
    const width = 320
    const height = 160
    const cx = width / 2
    const cy = height / 2
    const rx = width * 0.38
    const ry = height * 0.36

    const nodes: LayoutNode[] = visible.map((et, i) => {
      const angle = (i / visible.length) * 2 * Math.PI - Math.PI / 2
      return {
        id: et.id,
        name: et.name,
        color: et.color,
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle),
      }
    })

    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const edges = relationships
      .filter(r => visibleIds.has(r.source) && visibleIds.has(r.target) && r.source !== r.target)
      .map(r => ({
        source: nodeMap.get(r.source)!,
        target: nodeMap.get(r.target)!,
        name: r.name,
      }))

    return { nodes, edges, overflow }
  }, [entityTypes, relationships, maxNodes])

  if (entityTypes.length === 0) {
    return (
      <div className="flex items-center justify-center h-[160px] text-ink-muted/40 text-xs">
        No entity types defined
      </div>
    )
  }

  const nodeRadius = 14

  return (
    <svg
      viewBox="0 0 320 160"
      className="w-full h-auto max-h-[180px]"
      style={{ minHeight: 120 }}
    >
      {/* Edges */}
      {edges.map((e, i) => (
        <line
          key={`edge-${i}`}
          x1={e.source.x}
          y1={e.source.y}
          x2={e.target.x}
          y2={e.target.y}
          className="stroke-ink-muted/15 dark:stroke-ink-muted/10"
          strokeWidth={1}
        />
      ))}

      {/* Nodes */}
      {nodes.map(n => (
        <g key={n.id}>
          <circle
            cx={n.x}
            cy={n.y}
            r={nodeRadius}
            fill={n.color}
            opacity={0.15}
            className="transition-all"
          />
          <circle
            cx={n.x}
            cy={n.y}
            r={nodeRadius - 3}
            fill={n.color}
            opacity={0.7}
          />
          <text
            x={n.x}
            y={n.y + nodeRadius + 10}
            textAnchor="middle"
            className="fill-current text-ink-muted/70 dark:text-ink-muted/50"
            style={{ fontSize: 7, fontWeight: 600, fontFamily: 'var(--font-sans)' }}
          >
            {n.name.length > 12 ? n.name.slice(0, 11) + '...' : n.name}
          </text>
        </g>
      ))}

      {/* Overflow indicator */}
      {overflow > 0 && (
        <text
          x={310}
          y={155}
          textAnchor="end"
          className="fill-current text-ink-muted/40"
          style={{ fontSize: 8, fontWeight: 600 }}
        >
          +{overflow} more
        </text>
      )}
    </svg>
  )
}
