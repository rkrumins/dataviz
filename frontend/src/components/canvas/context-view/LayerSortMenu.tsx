/**
 * LayerSortMenu — per-layer node-ordering control in the LayerColumn header.
 *
 * Modes: "View default (A → Z | Z → A)" (clears the layer's override), explicit
 * A → Z / Z → A, and "Custom order" (drag-to-reorder, draft-only — it seeds
 * persisted orderKeys). "Apply to all layers" promotes the column's current
 * asc/desc mode to the view-wide default. Outside a draft the asc/desc choices
 * stay session-local (the canvas routes them to an ephemeral override map), so
 * the menu remains available to read-only viewers; the persisted-state actions
 * (Custom order / Apply to all) are disabled there.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowDownAZ, ArrowUpZA, Check, ListOrdered, SwatchBook } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LayerNodeSortMode } from '@/types/schema'

export interface LayerSortMenuProps {
  layerName: string
  layerColor?: string
  /** Effective sort mode for this column (override → layer → view default). */
  mode: LayerNodeSortMode
  /** True when the column deviates from the view default (shows the indicator dot). */
  isOverride: boolean
  /** The view-wide default (asc/desc) named in the "View default" item. */
  viewDefault: 'alpha-asc' | 'alpha-desc'
  /** Draft mode: enables Custom order + Apply to all layers. */
  canPersist: boolean
  /** `null` clears the layer override back to the view default. */
  onSelectMode: (mode: LayerNodeSortMode | null) => void
  onApplyToView: () => void
}

const MODE_ICONS: Record<LayerNodeSortMode, typeof ArrowDownAZ> = {
  'alpha-asc': ArrowDownAZ,
  'alpha-desc': ArrowUpZA,
  custom: ListOrdered,
}

const MODE_LABELS: Record<LayerNodeSortMode, string> = {
  'alpha-asc': 'A → Z',
  'alpha-desc': 'Z → A',
  custom: 'Custom order',
}

const itemClass =
  'flex items-center gap-2 px-2 py-1.5 text-xs text-ink rounded-md hover:bg-accent-lineage/10 cursor-pointer outline-none focus:bg-accent-lineage/10 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed'

export function LayerSortMenu({
  layerName,
  layerColor,
  mode,
  isOverride,
  viewDefault,
  canPersist,
  onSelectMode,
  onApplyToView,
}: LayerSortMenuProps) {
  const TriggerIcon = MODE_ICONS[mode]

  const item = (
    label: string,
    active: boolean,
    onSelect: () => void,
    Icon: typeof ArrowDownAZ,
    opts?: { disabled?: boolean; disabledHint?: string },
  ) => (
    <DropdownMenu.Item
      className={itemClass}
      disabled={opts?.disabled}
      title={opts?.disabled ? opts.disabledHint : undefined}
      onSelect={onSelect}
    >
      <Icon className="w-3.5 h-3.5 text-ink-muted" />
      <span className="flex-1">{label}</span>
      {active && <Check className="w-3 h-3 text-accent-lineage" />}
    </DropdownMenu.Item>
  )

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'relative p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-white/[0.1] transition-all duration-200',
            isOverride ? 'opacity-100' : 'opacity-0 group-hover/column:opacity-100 focus-visible:opacity-100',
          )}
          title={`Sort ${layerName}: ${MODE_LABELS[mode]}${isOverride ? '' : ' (view default)'}`}
        >
          <TriggerIcon className="w-3.5 h-3.5" />
          {isOverride && (
            <span
              className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: layerColor ?? 'var(--accent-lineage, #6366f1)' }}
            />
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[190px] bg-canvas-elevated border border-glass-border rounded-lg shadow-xl p-1 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          sideOffset={5}
          align="end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Sort nodes
          </DropdownMenu.Label>
          {item(
            `View default (${MODE_LABELS[viewDefault]})`,
            !isOverride,
            () => onSelectMode(null),
            MODE_ICONS[viewDefault],
          )}
          {item('A → Z', isOverride && mode === 'alpha-asc', () => onSelectMode('alpha-asc'), ArrowDownAZ)}
          {item('Z → A', isOverride && mode === 'alpha-desc', () => onSelectMode('alpha-desc'), ArrowUpZA)}
          {item('Custom order', mode === 'custom', () => onSelectMode('custom'), ListOrdered, {
            disabled: !canPersist,
            disabledHint: 'Open a draft to define a custom order',
          })}
          <DropdownMenu.Separator className="h-px bg-glass-border my-1" />
          {item('Apply to all layers', false, onApplyToView, SwatchBook, {
            disabled: !canPersist || mode === 'custom',
            disabledHint: !canPersist
              ? 'Open a draft to change how this view is sorted'
              : 'Custom order is per-layer and cannot be a view default',
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
