/**
 * A drawn line that stands for more than one relationship — a bundle, a
 * roll-up, a summary wire. Says what it summarises, and lists the relationships
 * behind it at the endpoints they really name; each opens on the drawer's trail.
 */
import { useMemo } from 'react'
import { ChevronRight, Crosshair, Waypoints } from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type EdgeMemberRef, type LineageNode } from '@/store/canvas'
import { useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual } from '@/hooks/useEntityVisual'
import { targetFromMember } from '@/lib/drawerEdgeTarget'
import { ActionButton } from '../EntityDrawer'
import { Section } from '../DrawerSection'
import { Bridge, DrawerHeaderRow, Notice } from './RelationshipParts'
import { useEndpoints, useOpenEndpoint, type Endpoint } from './useEndpoints'
import { openInEdgeExplorer, relationshipCopy } from './relationshipModel'

/** Rows rendered at once — the Edge Explorer's own cap. */
const ROW_CAP = 100

type ConnectionTarget = Extract<DrawerEdgeTarget, { kind: 'connection' }>

export function ConnectionView({ target, guard, onClose, resolveNode, onFocusNode, onLocateMany }: {
  target: ConnectionTarget
  guard: (step: () => void) => void
  onClose: () => void
  resolveNode?: (id: string) => LineageNode | null
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
}) {
  const relationshipTypes = useViewRelationshipTypes()
  const shown = target.members.slice(0, ROW_CAP)
  const ids = useMemo(() => [...new Set([
    target.source, target.target,
    ...target.members.slice(0, ROW_CAP).flatMap((m) => [m.source, m.target]),
  ])], [target])
  const endpoints = useEndpoints(ids, resolveNode)
  const opener = useOpenEndpoint(onFocusNode, resolveNode)
  const color = useEdgeVisual(target.types[0] ?? '').strokeColor
  const label = target.types.length === 1
    ? relationshipCopy(target.types[0], relationshipTypes).label
    : `${target.types.length || 'Several'} relationship types`
  const hasRollups = target.members.some((m) => m.rollup)

  const openMember = (m: EdgeMemberRef) =>
    guard(() => useCanvasStore.getState().openEdgeDrawer(targetFromMember(m, target.id)))

  return (
    <>
      <div className="flex-shrink-0 p-5 border-b border-glass-border">
        <DrawerHeaderRow badge="Connection" badgeColor={color} guard={guard} onClose={onClose} onFocusNode={onFocusNode} />
        <Bridge
          source={endpoints.get(target.source)!}
          target={endpoints.get(target.target)!}
          label={label}
          color={color}
          bidirectional={target.bidirectional}
          onOpen={(id) => guard(() => { void opener.open(id) })}
          pendingId={opener.pendingId}
          unreachableId={opener.unreachableId}
        />
        <p className="mt-3 text-xs text-ink-muted">
          Stands for <span className="font-semibold text-ink">{target.weight.toLocaleString()}</span>{' '}
          {target.weight === 1 ? 'flow' : 'flows'}
          {!target.summaryOnly && (
            <> · <span className="font-semibold text-ink">{target.members.length.toLocaleString()}</span>{' '}
              {target.members.length === 1 ? 'relationship' : 'relationships'} listed</>
          )}
        </p>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          {onLocateMany && (
            <ActionButton icon={Crosshair} label="Locate both ends" onClick={() => { void onLocateMany([target.source, target.target]) }} />
          )}
          <ActionButton
            icon={Waypoints}
            label="Edge Explorer"
            onClick={() => guard(() => {
              // The Explorer lists canvas edges, so select the members the canvas holds.
              const onCanvas = useCanvasStore.getState()._edgeIndex
              openInEdgeExplorer(target.members.filter((m) => onCanvas.has(m.id)).map((m) => m.id))
            })}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {target.types.length > 0 && (
          <Section title="Relationship types">
            <div className="flex flex-wrap gap-1.5">
              {target.types.map((t) => <TypeChip key={t} type={t} label={relationshipCopy(t, relationshipTypes).label} />)}
            </div>
          </Section>
        )}

        {target.summaryOnly ? (
          <Section title="Relationships">
            <Notice tone="info">
              This line summarises relationships between items inside these two. Expand either end — or
              double-click the line — to see them.
            </Notice>
          </Section>
        ) : (
          <Section title="Relationships">
            {hasRollups && (
              <div className="mb-2">
                <Notice tone="info">
                  Roll-up rows are summaries the aggregation job computes — change the relationships beneath them instead.
                </Notice>
              </div>
            )}
            <ul className="space-y-1.5" aria-label="Relationships this line stands for">
              {shown.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  label={relationshipCopy(m.edgeType, relationshipTypes).label}
                  source={endpoints.get(m.source)}
                  target={endpoints.get(m.target)}
                  onOpen={() => openMember(m)}
                />
              ))}
            </ul>
            {target.members.length > shown.length && (
              <p className="mt-2 text-[11px] text-ink-muted">
                +{(target.members.length - shown.length).toLocaleString()} more — expand either end to narrow down.
              </p>
            )}
          </Section>
        )}
      </div>
    </>
  )
}

function TypeChip({ type, label }: { type: string; label: string }) {
  const color = useEdgeVisual(type).strokeColor
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[11px] font-semibold border"
      style={{ color, backgroundColor: `${color}14`, borderColor: `${color}40` }}
      title={type}
    >
      {label}
    </span>
  )
}

function MemberRow({ member, label, source, target, onOpen }: {
  member: EdgeMemberRef
  label: string
  source?: Endpoint
  target?: Endpoint
  onOpen: () => void
}) {
  const color = useEdgeVisual(member.edgeType).strokeColor
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border-l-2 text-left bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-150"
        style={{ borderLeftColor: color }}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>{label}</span>
            {member.rollup && (
              <span className="px-1.5 py-px rounded text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">roll-up</span>
            )}
          </span>
          <span className="block text-xs text-ink truncate" title={`${member.source} → ${member.target}`}>
            {source?.name ?? member.source} <span className="text-ink-muted">→</span> {target?.name ?? member.target}
          </span>
        </span>
        <ChevronRight className="w-4 h-4 text-ink-muted flex-shrink-0" />
      </button>
    </li>
  )
}
