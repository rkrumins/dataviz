/**
 * LayerSortMenu — per-layer node-ordering control in the LayerColumn header.
 *
 * Modes: "View default (A → Z | Z → A)" (clears the layer's override), explicit
 * A → Z / Z → A, and "Custom order" (drag-to-reorder, draft-only — it seeds
 * persisted orderKeys). "Apply to all layers" promotes the column's current
 * asc/desc mode to the view-wide default. Outside a draft the asc/desc choices
 * stay session-local (the canvas routes them to an ephemeral override map) and
 * the menu says so; the persisted-state actions (Custom order / Apply to all)
 * are disabled there with an InfoTooltip explaining why.
 *
 * A11y: the four mode choices are a Radix RadioGroup (menuitemradio +
 * aria-checked for screen readers); the trigger carries an explicit aria-label.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowDownAZ, ArrowUpZA, Check, Layers, ListOrdered } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LayerNodeSortMode } from '@/types/schema'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'

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
          aria-label={`Sort ${layerName}: ${MODE_LABELS[mode]}${isOverride ? '' : ' (view default)'}`}
          className={cn(
            'relative p-1.5 rounded-lg text-ink-muted hover:text-ink transition-all duration-200',
            'hover:bg-black/[0.06] dark:hover:bg-white/[0.1]',
            // Sorting is a primary control: keep it faintly present at rest and
            // fully visible on column hover / focus (never fully hidden).
            isOverride
              ? 'opacity-100'
              : 'opacity-60 group-hover/column:opacity-100 focus-visible:opacity-100',
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
          className="min-w-[200px] bg-canvas-elevated/95 backdrop-blur-xl border border-glass-border rounded-lg shadow-xl p-1 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
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
              `View default (${MODE_LABELS[viewDefault]})`,
              MODE_ICONS[viewDefault],
              () => onSelectMode(null),
            )}
            {radioItem('alpha-asc', 'A → Z', ArrowDownAZ, () => onSelectMode('alpha-asc'))}
            {radioItem('alpha-desc', 'Z → A', ArrowUpZA, () => onSelectMode('alpha-desc'))}
            {radioItem('custom', 'Custom order', ListOrdered, () => onSelectMode('custom'), {
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
          {/* Viewers' asc/desc picks are session-local — say so instead of
              letting the reset on reload feel like a bug. */}
          {!canPersist && isOverride && (
            <>
              <DropdownMenu.Separator className="h-px bg-glass-border my-1" />
              <div className="px-2 py-1 text-[10px] text-ink-muted/70">
                Session only · resets on reload
              </div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
