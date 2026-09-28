/**
 * A drawn line that stands for more than one relationship — a bundle, a
 * roll-up, a summary wire. Says what it summarises, and lists the relationships
 * behind it at the endpoints they really name; each opens on the drawer's trail.
 *
 * Relationships and roll-ups are easy to tell apart: the relationships come
 * first, with why the line joins these two cards when their ends are inside them;
 * roll-ups — read-only summaries — are listed apart, with what they are. When a
 * line holds both, All · Relationships · Roll-ups narrows the list to one kind.
 *
 * A roll-up's own relationships are between entities inside the two cards, which
 * the canvas has not loaded: they are read from the data source and listed with
 * the rest, each openable like any other.
 */
import { useId, useMemo, useState } from 'react'
import { ChevronRight, Crosshair, Waypoints } from 'lucide-react'
import { useCanvasStore, type DrawerEdgeTarget, type EdgeMemberRef, type LineageNode } from '@/store/canvas'
import { useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { useEdgeVisual, useEntityColorSet, useEntityTypeLabel } from '@/hooks/useEntityVisual'
import { targetFromMember } from '@/lib/drawerEdgeTarget'
import { useRelationshipsBeneath } from '@/hooks/useRelationshipsBeneath'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { Section } from '../DrawerSection'
import { DrawerBody, DrawerHeader, DrawerShell } from '../shell/DrawerShell'
import { DrawerTopBar, KindBadge } from '../shell/DrawerTopBar'
import { Bridge, Notice, TypeChip } from './RelationshipParts'
import { useEndpoints, useOpenEndpoint, type Endpoint } from './useEndpoints'
import type { GraphEdge } from '@/providers/GraphDataProvider'
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
  // A roll-up (or a summary wire) stands for relationships the canvas has not loaded: read them.
  const rolledUp = !!target.summaryOnly || target.members.some((m) => m.rollup)
  const beneath = useRelationshipsBeneath(target.source, target.target, !!target.bidirectional, rolledUp)
  const allRelationships = useMemo(() => withBeneath(target.members.filter((m) => !m.rollup), beneath.data?.edges), [target.members, beneath.data])
  const allRollups = useMemo(() => target.members.filter((m) => m.rollup), [target.members])
  const relationships = allRelationships.slice(0, ROW_CAP)
  const rollups = allRollups.slice(0, ROW_CAP)
  const hidden = allRelationships.length - relationships.length + allRollups.length - rollups.length
  const truncated = !!beneath.data?.truncated
  const ids = useMemo(() => [...new Set([
    target.source, target.target,
    ...[...allRelationships.slice(0, ROW_CAP), ...allRollups.slice(0, ROW_CAP)].flatMap((m) => [m.source, m.target]),
  ])], [target.source, target.target, allRelationships, allRollups])
  const endpoints = useEndpoints(ids, resolveNode)
  const opener = useOpenEndpoint(onFocusNode, resolveNode)
  const color = useEdgeVisual(target.types[0] ?? '').strokeColor
  const label = target.types.length === 1
    ? relationshipCopy(target.types[0], relationshipTypes).label
    : `${target.types.length || 'Several'} relationship types`
  const relationshipCount = allRelationships.length
  const rollupCount = allRollups.length
  // Counted once they are known: all loaded, or read from the data source.
  const counted = !rolledUp || !!beneath.data
  // A relationship whose ends are inside the two cards, not the cards themselves.
  const sameEnds = (m: EdgeMemberRef) => (m.source === target.source && m.target === target.target)
    || (!!target.bidirectional && m.source === target.target && m.target === target.source)
  const inside = allRelationships.some((m) => !sameEnds(m))
  // Both kinds on one line: the reader can narrow the list to either.
  const mixed = relationshipCount > 0 && rollupCount > 0
  const [kind, setKind] = useState<'all' | 'relationships' | 'rollups'>('all')
  const listRelationships = !mixed || kind !== 'rollups'
  const listRollups = !mixed || kind !== 'relationships'
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
          {counted && (
            <> · <span className="font-semibold text-ink">{relationshipCount.toLocaleString()}{truncated && '+'}</span>{' '}
              {relationshipCount === 1 && !truncated ? 'relationship' : 'relationships'}</>
          )}
          {rollupCount > 0 && (
            <> · <span className="font-semibold text-ink">{rollupCount.toLocaleString()}</span>{' '}
              {rollupCount === 1 ? 'roll-up' : 'roll-ups'}</>
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

        <Section
          title="Relationships"
          action={mixed ? (
            <Segmented
              label="Show"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'all', label: 'All', count: relationshipCount + rollupCount },
                { value: 'relationships', label: 'Relationships', count: relationshipCount },
                { value: 'rollups', label: 'Roll-ups', count: rollupCount },
              ]}
            />
          ) : undefined}
        >
          {listRelationships && (
            <>
              {inside && (
                <div className="mb-2">
                  <Notice tone="info">
                    These relationships join entities inside {source.name} and {dest.name}; the line is drawn
                    between the cards that hold them. Open one to see it and, in a draft, change it.
                  </Notice>
                </div>
              )}
              {relationships.length > 0 ? (
                <ul className="space-y-1.5" aria-label="Relationships this line stands for">
                  {relationships.map((m) => (
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
              ) : !beneath.isLoading && (
                beneath.data ? (
                  <p className="text-xs text-ink-muted">None found between the entities inside these two.</p>
                ) : (
                  <Notice tone="info">
                    This line summarises relationships between entities inside these two. Expand either end — or
                    double-click the line — to see them.
                  </Notice>
                )
              )}
              {beneath.isLoading && (
                <div className="space-y-1.5 mt-1.5" aria-label="Loading the relationships this line stands for">
                  {[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)}
                </div>
              )}
            </>
          )}
          {listRollups && rollups.length > 0 && (
            <div className={listRelationships ? 'mt-5' : undefined}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Roll-ups · read-only</h4>
              <div className="mb-2">
                <Notice tone="info">
                  Summaries the aggregation job computes from relationships between entities inside these cards.
                  To change one, change the relationships it summarises.
                </Notice>
              </div>
              <ul className="space-y-1.5" aria-label="Roll-ups this line stands for">
                {rollups.map((m) => (
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
            </div>
          )}
        </Section>
        {(hidden > 0 || truncated) && (
          <p className="px-5 pb-4 text-[11px] text-ink-muted">
            {hidden > 0 ? `+${hidden.toLocaleString()} more${truncated ? ', and possibly others' : ''}` : 'There may be others'}
            {' '}— expand either end to narrow down.
          </p>
        )}
      </DrawerBody>
    </DrawerShell>
  )
}

/** The loaded relationships, then those read from the data source that are not already among them
 *  — by (source, target, type), which writes keep unique (a canvas copy's id can differ). */
function withBeneath(loaded: EdgeMemberRef[], read: GraphEdge[] | undefined): EdgeMemberRef[] {
  if (!read?.length) return loaded
  const key = (m: EdgeMemberRef) => `${m.source}\n${m.target}\n${m.edgeType.toUpperCase()}`
  const seen = new Set(loaded.map(key))
  const more: EdgeMemberRef[] = []
  for (const e of read) {
    const m = { id: e.id, source: e.sourceUrn, target: e.targetUrn, edgeType: e.edgeType, rollup: false }
    if (seen.has(key(m))) continue
    seen.add(key(m))
    more.push(m)
  }
  return [...loaded, ...more]
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
