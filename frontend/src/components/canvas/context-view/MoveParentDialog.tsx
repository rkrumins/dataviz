/**
 * Move to another parent… — the entity menu's way to change where an entity sits in the DATA.
 * Before anything is picked it says what that changes: the entity and everything inside it move
 * under the new parent in every view that shows it (the other views on the data source named and
 * counted, when there are some), its lineage untouched. Then the same search the drawer offers
 * (MoveTargetPicker) picks the parent — or, where its type may stand alone, none. Staged like every
 * move, through useReparentNode: ontology-checked, refused with a reason, reviewed on save.
 *
 * Kept mounted (a closed Radix dialog never strands a click shield): open while `nodeId` is set.
 */
import { CornerLeftUp, FolderInput, Home } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { MoveTargetPicker } from '@/components/panels/entity/EntityPlacement'
import { useContainmentParent } from '@/components/panels/entity/useContainment'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { usePersonaMode } from '@/store/persona'
import { ChangeKindTag } from './DropHint'
import { moveDialogBody, moveDialogReach, reachNote, type DataReach } from './changeKind'
import { useReparentNode } from './useReparentNode'

export function MoveParentDialog({ nodeId, reach, onClose }: {
  /** The entity to move; none: closed. */
  nodeId: string | null
  /** Who the move reaches. */
  reach: DataReach
  onClose: () => void
}) {
  const id = nodeId ?? ''
  const { reparent, moveToTopLevel, topLevelVerdict } = useReparentNode()
  const { node, parentNode, parentName } = useContainmentParent(id)
  const persona = usePersonaMode()
  const name = resolveEntityName(node?.data, persona, id)
  const others = moveDialogReach(name, reach)
  const note = others ? reachNote(reach, persona) : undefined
  const open = !!nodeId && !!node

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose() }}
      title={open ? `Move ${name} to another parent` : 'Move to another parent'}
      description={open ? moveDialogBody(name, reach) : undefined}
      icon={(
        <span className="grid place-items-center w-9 h-9 rounded-xl bg-accent-lineage/12 text-accent-lineage">
          <FolderInput className="w-4 h-4" aria-hidden />
        </span>
      )}
    >
      {open && (
        <div className="space-y-3">
          <ChangeKindTag kind="data" reach={reach} />
          {others && (
            <p className="text-[13px] leading-relaxed text-ink-secondary">
              {others}
              {note && <span className="block mt-0.5 text-xs text-ink-muted">{note}</span>}
            </p>
          )}
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            {parentNode
              ? <><CornerLeftUp className="w-3.5 h-3.5 shrink-0" aria-hidden /><span>Now inside <span className="font-semibold text-ink">{parentName ?? parentNode.id}</span></span></>
              : <><Home className="w-3.5 h-3.5 shrink-0" aria-hidden /><span>At the top level</span></>}
          </p>
          <MoveTargetPicker
            key={id}
            nodeId={id}
            defaultOpen
            onCancel={onClose}
            canStandAlone={() => !!parentNode && topLevelVerdict(id).kind === 'data'}
            onPick={(parentId) => { onClose(); reparent(id, parentId) }}
            onTop={() => { onClose(); moveToTopLevel(id) }}
          />
        </div>
      )}
    </Dialog>
  )
}
