/**
 * A drawn line that stands for more than one relationship — a bundle, a
 * roll-up, a summary wire. Says what it summarises, and lists the relationships
 * behind it at the endpoints they really name; each opens on the drawer's trail.
 */
import { useId, useMemo } from 'react'
import { ChevronRight, Crosshair, Waypoints } from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type EdgeMemberRef, type LineageNode } from '@/store/canvas'
import { useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual, useEntityColorSet, useEntityTypeLabel } from '@/hooks/useEntityVisual'
import { targetFromMember } from '@/lib/drawerEdgeTarget'
import { Button } from '@/components/ui/Button'
import { Section } from '../DrawerSection'
import { DrawerBody, DrawerHeader, DrawerShell } from '../shell/DrawerShell'
import { DrawerTopBar, KindBadge } from '../shell/DrawerTopBar'
import { Bridge, Notice, TypeChip } from './RelationshipParts'
import { useEndpoints, useOpenEndpoint, type Endpoint } from './useEndpoints'
import { openInEdgeExplorer, relationshipCopy } from './relationshipModel'

/** Rows rendered at once — the Edge Explorer's own cap. */
const ROW_CAP = 100

type ConnectionTarget = Extract<DrawerEdgeTarget, { kind: 'connection' }>

export function ConnectionView({ target, onClose, resolveNode, onFocusNode, onLocateMany }: {
  target: ConnectionTarget
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
  const titleId = useId()
  const source = endpoints.get(target.source)!
  const dest = endpoints.get(target.target)!

  const openMember = (m: EdgeMemberRef) => useCanvasStore.getState().openEdgeDrawer(targetFromMember(m, target.id))

  return (
    <DrawerShell titleId={titleId} focusKey={target.id} onClose={onClose}>
      <DrawerHeader>
        <DrawerTopBar
          badge={<KindBadge label="Connection" bg={`${color}1a`} fg={color} />}
          closeLabel="Close relationship details"
          onClose={onClose}
          onFocusNode={onFocusNode}
        />
        <h2 id={titleId} tabIndex={-1} className="sr-only">Connection: {source.name} and {dest.name}</h2>
        <Bridge
          source={source}
          target={dest}
          label={label}
          color={color}
          bidirectional={target.bidirectional}
          onOpen={opener.open}
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
            <Button size="sm" variant="subtle" leftIcon={Crosshair} onClick={() => { void onLocateMany([target.source, target.target]) }}>
              Locate both ends
            </Button>
          )}
          <Button
            size="sm"
            variant="subtle"
            leftIcon={Waypoints}
            onClick={() => {
              // The Explorer lists canvas edges, so select the members the canvas holds.
              const onCanvas = useCanvasStore.getState()._edgeIndex
              openInEdgeExplorer(target.members.filter((m) => onCanvas.has(m.id)).map((m) => m.id))
            }}
          >
            Edge Explorer
          </Button>
        </div>
      </DrawerHeader>

      <DrawerBody>
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
      </DrawerBody>
    </DrawerShell>
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
          <span className="flex items-center gap-1 min-w-0 text-xs text-ink">
            <EndName endpoint={source} id={member.source} />
            <span className="text-ink-muted flex-shrink-0" aria-hidden>→</span>
            <EndName endpoint={target} id={member.target} />
          </span>
        </span>
        <ChevronRight className="w-4 h-4 text-ink-muted flex-shrink-0" />
      </button>
    </li>
  )
}

/** One end of a listed relationship: its name, a dot in its type's colour; type and id on hover. */
function EndName({ endpoint, id }: { endpoint?: Endpoint; id: string }) {
  const colors = useEntityColorSet(endpoint?.type ?? '')
  const typeLabel = useEntityTypeLabel(endpoint?.type)
  return (
    <span className="flex items-center gap-1 min-w-0 max-w-[50%]" title={[typeLabel, id].filter(Boolean).join(' · ')}>
      {endpoint?.type && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: colors.hex }} aria-hidden />}
      <span className="truncate">{endpoint?.name ?? id}</span>
    </span>
  )
}
