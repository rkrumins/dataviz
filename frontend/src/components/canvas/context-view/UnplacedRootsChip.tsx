/**
 * UnplacedRootsChip — the top-level entities of the types a view is about that it doesn't place:
 * new ones an ingestion, a sync or another draft's publish brought, or ones left out on purpose.
 * From here it is only known that they are not placed, so that is all it says.
 *
 * A quiet chip in the status cluster, and a small sheet with three choices — never done for the
 * reader:
 *   • Add each as a column — a column mapped to each (the wizard's thresholds: past
 *     ENTITY_COLUMNS_WARN it asks first, past ENTITY_COLUMNS_MAX it is not offered);
 *   • Add them to ‹column› — placed in the column chosen;
 *   • Not now — hidden for this view until the number changes.
 * Outside a draft it offers the way into one instead of the first two.
 */
import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Sparkles } from 'lucide-react'
import { ENTITY_COLUMNS_MAX, ENTITY_COLUMNS_WARN } from '@/components/views/ViewWizard/useTopLevelEntities'

const CHIP_CLASS =
  'pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md ' +
  'border border-black/10 dark:border-white/10 shadow-md text-[11px] font-medium text-ink-muted bg-canvas-elevated/80 ' +
  'cursor-pointer hover:scale-105 active:scale-95 transition-transform'
const PRIMARY =
  'w-full px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/15 ' +
  'cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const QUIET =
  'w-full px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] ' +
  'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const HINT = 'pt-1 text-[10.5px] text-ink-muted leading-snug'
const LIST_CAP = 6

export interface UnplacedRootsChipProps {
  /** How many of each type, with the type's names for one and for many. */
  byType: Array<{ type: string; one: string; many: string; count: number }>
  /** The count is a lower bound (the read stopped at its ceiling). */
  atLeast?: boolean
  /** The first of them, by name — what the choices add. */
  listed: Array<{ urn: string; name: string; typeName: string }>
  /** Columns they can be placed in, the likeliest first. Absent outside a draft. */
  columns?: Array<{ id: string; name: string }>
  onAddAsColumns?: () => void
  onAddToColumn?: (layerId: string) => void
  /** Outside a draft, for a reader who can open one. */
  onOpenDraft?: () => void
  onNotNow: () => void
}

/** "3 Domains aren’t in this view", "1 Domain isn’t", "5 top-level entities aren’t". */
function unplacedRootsLabel(byType: UnplacedRootsChipProps['byType'], atLeast = false): string {
  const total = byType.reduce((n, t) => n + t.count, 0)
  const one = total === 1 && !atLeast
  const noun = byType.length === 1
    ? (one ? byType[0].one : byType[0].many)
    : (one ? 'top-level entity' : 'top-level entities')
  return `${total.toLocaleString()}${atLeast ? '+' : ''} ${noun} ${one ? 'isn’t' : 'aren’t'} in this view`
}

export function UnplacedRootsChip({
  byType, atLeast = false, listed, columns, onAddAsColumns, onAddToColumn, onOpenDraft, onNotNow,
}: UnplacedRootsChipProps) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const total = byType.reduce((n, t) => n + t.count, 0)
  const label = unplacedRootsLabel(byType, atLeast)
  const tooMany = total > ENTITY_COLUMNS_MAX || atLeast
  const column = columns?.find((c) => c.id === chosen) ?? columns?.[0]
  const some = listed.length < total
  const act = (fn: () => void) => { setOpen(false); setConfirming(false); fn() }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setConfirming(false) }}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={CHIP_CLASS}>
          <Sparkles className="w-3 h-3 text-sky-500/80" aria-hidden />
          <span>{label}</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={6}
          className="z-[9999] w-80 rounded-lg border border-glass-border bg-canvas-elevated shadow-xl shadow-black/40 p-3"
        >
          <p className="text-[12px] font-semibold text-ink">{label}</p>
          <p className="pt-1 text-[11px] text-ink-muted leading-relaxed">
            This source has top-level entities this view doesn’t place. They may have arrived with an ingestion, a
            sync or another draft’s publish — or be left out on purpose. Nothing changes unless you choose.
          </p>
          {byType.length > 1 && (
            <p className="pt-1.5 text-[11px] text-ink tabular-nums">
              {byType.map((t) => `${t.count.toLocaleString()} ${t.count === 1 ? t.one : t.many}`).join(' · ')}
            </p>
          )}
          <ul className="mt-2 max-h-40 overflow-y-auto custom-scrollbar">
            {listed.slice(0, LIST_CAP).map((e) => (
              <li key={e.urn} className="py-0.5 flex items-center gap-2 min-w-0" title={e.urn}>
                <span className="truncate text-[11.5px] text-ink">{e.name}</span>
                <span className="ml-auto flex-shrink-0 text-[10px] text-ink-muted">{e.typeName}</span>
              </li>
            ))}
          </ul>
          {total > LIST_CAP && (
            <p className="text-[10.5px] text-ink-muted tabular-nums">
              +{(total - Math.min(LIST_CAP, listed.length)).toLocaleString()}{atLeast ? '+' : ''} more
            </p>
          )}

          <div className="mt-3 pt-3 border-t border-glass-border/60 space-y-3">
            {confirming ? (
              <div>
                <p className="text-[11.5px] font-semibold text-ink">Add {listed.length.toLocaleString()} columns?</p>
                <p className={HINT}>Each shows what’s inside one of them. One change, undone in one step.</p>
                <div className="pt-2 flex gap-2">
                  <button type="button" className={PRIMARY} onClick={() => act(onAddAsColumns!)}>
                    Add {listed.length.toLocaleString()} columns
                  </button>
                  <button type="button" className={QUIET} onClick={() => setConfirming(false)}>Back</button>
                </div>
              </div>
            ) : (
              <>
                {onAddAsColumns && (
                  <div>
                    <button
                      type="button"
                      className={PRIMARY}
                      disabled={tooMany}
                      onClick={() => (total > ENTITY_COLUMNS_WARN ? setConfirming(true) : act(onAddAsColumns))}
                    >
                      Add each as a column
                    </button>
                    <p className={HINT}>
                      {tooMany
                        ? `More than ${ENTITY_COLUMNS_MAX.toLocaleString()} — too many for a column each.`
                        : 'A column for each, showing what’s inside it.'}
                    </p>
                  </div>
                )}
                {onAddToColumn && column && (
                  <div>
                    <div className="flex items-center gap-2">
                      <button type="button" className={`${PRIMARY} flex-1 min-w-0 truncate`} onClick={() => act(() => onAddToColumn(column.id))}>
                        {some ? `Add the first ${listed.length.toLocaleString()} to ${column.name}` : `Add them to ${column.name}`}
                      </button>
                      {columns!.length > 1 && (
                        <select
                          aria-label="Column"
                          value={column.id}
                          onChange={(e) => setChosen(e.target.value)}
                          className="flex-none max-w-[7rem] rounded-md border border-glass-border bg-canvas px-1.5 py-1 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                        >
                          {columns!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                    </div>
                    <p className={HINT}>Rows in one column.</p>
                  </div>
                )}
                {onOpenDraft && (
                  <button type="button" className={PRIMARY} onClick={() => act(onOpenDraft)}>Open a draft to add them</button>
                )}
                <div>
                  <button type="button" className={QUIET} onClick={() => act(onNotNow)}>Not now</button>
                  <p className={HINT}>Hidden for this view until the number changes.</p>
                </div>
              </>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
