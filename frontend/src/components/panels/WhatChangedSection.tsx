/**
 * WhatChangedSection — a drawer's "What changed", leading it when the entity or relationship shown
 * has a change in the change set the canvas draws (a draft's saved changes, or two revisions
 * compared): whether it was added or modified, and where, then each field (`ChangeDetail`).
 *
 * It shows whether or not a review is open, so choosing any changed entity on the canvas says what
 * changed. An unchanged one shows nothing and asks for nothing; a deletion has its own details.
 */
import { GitCompareArrows } from 'lucide-react'
import { useBranchStore } from '@/store/branchStore'
import { listOriginOf } from '@/features/versioning/canvas/useDeletionGhosts'
import { ChangeDetail } from '@/features/versioning/components/ChangeDetail'
import { NodeDiffBadge } from '@/features/versioning/components/NodeDiffBadge'
import { Section } from './DrawerSection'

/** `id`: the entity's urn (a canvas node's id), or a relationship's entity id. */
export function WhatChangedSection({ id }: { id?: string | null }) {
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const wsId = useBranchStore((s) => s.workspaceId)
  const graphId = useBranchStore((s) => s.graphId)
  const change = id ? changeSet?.byEntityId.get(id) : undefined
  const origin = listOriginOf(changeSet)
  if (!change || change.status === 'removed' || !origin || !wsId || !graphId) return null
  return (
    <Section title="What changed" icon={GitCompareArrows}>
      <p className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-muted">
        <NodeDiffBadge status={change.status} withLabel />
        {'branchId' in origin ? 'in this draft' : `between #${origin.fromSeq} and #${origin.toSeq}`}
      </p>
      <ChangeDetail wsId={wsId} graphId={graphId} origin={origin} entityId={change.entityId} label={change.label} />
    </Section>
  )
}
