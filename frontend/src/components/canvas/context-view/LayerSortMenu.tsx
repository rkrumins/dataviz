/**
 * LayerSortMenu — per-layer node-ordering control in the LayerColumn header.
 *
 * Modes: "View default (…)" (clears the layer's override), the algorithmic
 * orders — A → Z, Z → A, By type, Most children — and "Custom order"
 * (drag-to-reorder, draft-only — it seeds persisted orderKeys). "Apply to all
 * layers" promotes the column's current algorithmic mode to the view-wide
 * default; "Reset custom order" discards a manual arrangement (keys + mode).
 * Outside a draft the algorithmic choices stay session-local (persisted
 * per-device, the menu says so); the persisted-state actions are disabled
 * there with an InfoTooltip explaining why.
 *
 * A11y: the mode choices are a Radix RadioGroup (menuitemradio +
 * aria-checked for screen readers); the trigger carries an explicit aria-label.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowDownAZ, ArrowUpZA, Check, Eraser, GitFork, Layers, ListOrdered, Shapes } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LayerNodeSortAlgo, LayerNodeSortMode } from '@/types/schema'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'

export interface LayerSortMenuProps {
  layerName: string
  layerColor?: string
  /** Effective sort mode for this column (override → layer → view default). */
  mode: LayerNodeSortMode
  /** True when the column deviates from the view default (shows the indicator dot). */
  isOverride: boolean
  /** The view-wide default (algorithmic) named in the "View default" item. */
  viewDefault: LayerNodeSortAlgo
  /** Draft mode: enables Custom order / Apply to all layers / Reset. */
  canPersist: boolean
  /** `null` clears the layer override back to the view default. */
  onSelectMode: (mode: LayerNodeSortMode | null) => void
  onApplyToView: () => void
  /** Presence shows "Reset custom order" (the layer has a manual arrangement). */
  onResetCustomOrder?: () => void
}

export const SORT_MODE_ICONS: Record<LayerNodeSortMode, typeof ArrowDownAZ> = {
  'alpha-asc': ArrowDownAZ,
  'alpha-desc': ArrowUpZA,
  'type-asc': Shapes,
  'count-desc': GitFork,
  custom: ListOrdered,
}

export const SORT_MODE_LABELS: Record<LayerNodeSortMode, string> = {
  'alpha-asc': 'A → Z',
  'alpha-desc': 'Z → A',
  'type-asc': 'By type',
  'count-desc': 'Most children',
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
  onResetCustomOrder,
}: LayerSortMenuProps) {
  const TriggerIcon = SORT_MODE_ICONS[mode]
  // Radio value: 'default' when the column follows the view default; else the
  // effective mode (an override — persisted or session-local).
  const radioValue = isOverride ? mode : 'default'

  const radioItem = (
    value: string,
    label: string,
    Icon: typeof ArrowDownAZ,
    onSelect: () => void,
    opts?: { disabled?: boolean; disabledHint?: string },
  ) => {
    const item = (
      <DropdownMenu.RadioItem
        value={value}
        className={itemClass}
        disabled={opts?.disabled}
        onSelect={onSelect}
      >
        <Icon className="w-3.5 h-3.5 text-ink-muted" />
        <span className="flex-1">{label}</span>
        {radioValue === value && <Check className="w-3 h-3 text-accent-lineage" />}
      </DropdownMenu.RadioItem>
    )
    return opts?.disabled && opts.disabledHint ? (
      <InfoTooltip content={opts.disabledHint} side="right">
        {item}
      </InfoTooltip>
    ) : (
      item
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          aria-label={`Sort ${layerName}: ${SORT_MODE_LABELS[mode]}${isOverride ? '' : ' (view default)'}`}
          className={cn(
            'relative p-1.5 rounded-lg text-ink-muted hover:text-ink transition-all duration-200',
            'hover:bg-black/[0.06] dark:hover:bg-white/[0.1]',
            // Sorting is a primary control: keep it faintly present at rest and
            // fully visible on column hover / focus (never fully hidden).
            isOverride
              ? 'opacity-100'
              : 'opacity-60 group-hover/column:opacity-100 focus-visible:opacity-100',
          )}
          title={`Sort ${layerName}: ${SORT_MODE_LABELS[mode]}${isOverride ? '' : ' (view default)'}`}
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
          className="min-w-[210px] bg-canvas-elevated/95 backdrop-blur-xl border border-glass-border rounded-lg shadow-xl p-1 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          sideOffset={5}
          align="end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Sort nodes
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={radioValue}>
            {radioItem(
              'default',
              `View default (${SORT_MODE_LABELS[viewDefault]})`,
              SORT_MODE_ICONS[viewDefault],
              () => onSelectMode(null),
            )}
            {radioItem('alpha-asc', SORT_MODE_LABELS['alpha-asc'], ArrowDownAZ, () => onSelectMode('alpha-asc'))}
            {radioItem('alpha-desc', SORT_MODE_LABELS['alpha-desc'], ArrowUpZA, () => onSelectMode('alpha-desc'))}
            {radioItem('type-asc', SORT_MODE_LABELS['type-asc'], Shapes, () => onSelectMode('type-asc'))}
            {radioItem('count-desc', SORT_MODE_LABELS['count-desc'], GitFork, () => onSelectMode('count-desc'))}
            {radioItem('custom', SORT_MODE_LABELS.custom, ListOrdered, () => onSelectMode('custom'), {
              disabled: !canPersist,
              disabledHint: 'Open a draft to define a custom order',
            })}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="h-px bg-glass-border my-1" />
          {(() => {
            const disabled = !canPersist || mode === 'custom'
            const item = (
              <DropdownMenu.Item className={itemClass} disabled={disabled} onSelect={onApplyToView}>
                <Layers className="w-3.5 h-3.5 text-ink-muted" />
                <span className="flex-1">Apply to all layers</span>
              </DropdownMenu.Item>
            )
            return disabled ? (
              <InfoTooltip
                side="right"
                content={
                  !canPersist
                    ? 'Open a draft to change how this view is sorted'
                    : 'Custom order is per-layer and cannot be a view default'
                }
              >
                {item}
              </InfoTooltip>
            ) : (
              item
            )
          })()}
          {onResetCustomOrder && (() => {
            const item = (
              <DropdownMenu.Item
                className={itemClass}
                disabled={!canPersist}
                onSelect={onResetCustomOrder}
              >
                <Eraser className="w-3.5 h-3.5 text-ink-muted" />
                <span className="flex-1">Reset custom order</span>
              </DropdownMenu.Item>
            )
            return !canPersist ? (
              <InfoTooltip side="right" content="Open a draft to reset this layer's custom order">
                {item}
              </InfoTooltip>
            ) : (
              item
            )
          })()}
          {/* Viewers' sort picks are device-local — say so instead of letting
              "everyone else sees alphabetical" feel like a bug. */}
          {!canPersist && isOverride && (
            <>
              <DropdownMenu.Separator className="h-px bg-glass-border my-1" />
              <div className="px-2 py-1 text-[10px] text-ink-muted/70">
                Only on this device · not saved to the view
              </div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
