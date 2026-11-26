/**
 * "Map this column to…" / "Map to another entity…" — the column becomes an entity: its rows are
 * what is inside that entity. Before anything is picked it says what that means — adding or dropping
 * in the column will put things inside the entity (a data change) — and that mapping itself only
 * changes this view. Then a search over the top-level entities the view has (the look every entity
 * picker shares: EntitySearchPicker), the column's own entity first.
 *
 * Kept mounted (a closed Radix dialog never strands a click shield): open while `column` is set.
 */
import { Link2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { EntitySearchPicker, type PickerOption } from '@/components/panels/entity/EntitySearchPicker'
import { ChangeKindTag } from './DropHint'

export interface MapCandidate {
  id: string
  name: string
  /** Its type, by name. */
  type: string
  /** Where it is now: "In this column", "In Domains", "Has its own column, Finance". */
  where?: string
}

export function MapColumnDialog({ column, candidates, onPick, onClose }: {
  /** The column to map, by its name and whether it is mapped now; none: closed. */
  column: { name: string; mapped: boolean } | null
  candidates: readonly MapCandidate[]
  onPick: (entityId: string) => void
  onClose: () => void
}) {
  const open = !!column
  const options: PickerOption[] = candidates.map((c) => ({ id: c.id, label: c.name, badge: c.type, detail: c.where }))
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose() }}
      title={column ? `Map the ${column.name} column to ${column.mapped ? 'another' : 'an'} entity` : 'Map a column to an entity'}
      description={column
        ? 'The column becomes that entity: its rows are what’s inside it, and adding or dropping there puts things inside it — which changes the data.'
        : undefined}
      icon={(
        <span className="grid place-items-center w-9 h-9 rounded-xl bg-accent-lineage/12 text-accent-lineage">
          <Link2 className="w-4 h-4" aria-hidden />
        </span>
      )}
    >
      {column && (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-[13px] leading-relaxed text-ink-secondary">
            <ChangeKindTag kind="view" />
            <span>Mapping only changes how this view shows it.</span>
          </p>
          <EntitySearchPicker
            options={options}
            onPick={(id) => { onClose(); onPick(id) }}
            onCancel={onClose}
            searchLabel="Search for an entity to map it to"
            listLabel="Top-level entities"
            placeholder={`Search ${candidates.length.toLocaleString()} top-level entities…`}
            emptyText="This view has no top-level entities to map it to yet."
            autoFocus
          />
        </div>
      )}
    </Dialog>
  )
}
