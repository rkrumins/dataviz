/**
 * The small mark on a column's icon tile that says what kind of column it is (see columnKind.ts):
 * a link for a column mapped to an entity, shapes for one that shows a type (or a rule's pick), a
 * pin for one picked by hand. It sits over the tile's corner and takes no width, so it fits every
 * header size and the folded spine. Hovering it (or focusing it) explains the kind; the name's card
 * says the same, with the way to the mapped entity's details.
 */
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { COLUMN_KIND_ICON, type ColumnKind, type ColumnKindCopy } from './columnKind'

export function ColumnKindMark({ kind, copy, small = false }: {
  kind: ColumnKind
  copy: ColumnKindCopy
  /** A compact header's tile, or a spine's. */
  small?: boolean
}) {
  const Icon = COLUMN_KIND_ICON[kind]
  return (
    <HoverTip
      className="absolute -bottom-1 -right-1 z-[1] flex"
      width="data"
      label={copy.label}
      detail={(
        <>
          {copy.detail}
          {copy.technical && <span className="block mt-1 font-mono text-[10.5px] break-all">{copy.technical}</span>}
        </>
      )}
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={copy.label}
        data-column-kind={kind}
        className={cn(
          'grid place-items-center rounded-full bg-canvas-elevated text-ink-secondary',
          'ring-1 ring-black/[0.12] dark:ring-white/20 shadow-[0_1px_3px_rgb(0_0_0_/_0.18)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/60',
          small ? 'w-3.5 h-3.5' : 'w-4 h-4',
        )}
      >
        <Icon className={small ? 'w-2 h-2' : 'w-2.5 h-2.5'} strokeWidth={2.5} aria-hidden />
      </span>
    </HoverTip>
  )
}
