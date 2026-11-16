/**
 * The edge, surface, focus ring and states every text-like control shares (Input, NumberInput,
 * QuantityInput, Select), so they line up and look like one family.
 *
 * The edge is `glass-border/80`, a real divider in both themes; plain `glass-border` is white glass
 * and draws no edge at all on a light surface.
 */
import { cn } from '@/lib/utils'

export const CONTROL_SHELL = cn(
    'flex items-center rounded-xl border bg-canvas text-ink transition-[border-color,box-shadow] duration-150',
    'border-glass-border/80 hover:border-glass-border',
    'focus-within:border-accent-lineage/60 focus-within:ring-2 focus-within:ring-accent-lineage/25',
)
export const CONTROL_INVALID = 'border-rose-500/60 hover:border-rose-500/70 focus-within:border-rose-500/70 focus-within:ring-rose-500/20'
export const CONTROL_DISABLED = 'opacity-55 cursor-not-allowed'
export const CONTROL_SIZE = { sm: 'h-8 text-xs', md: 'h-9 text-sm' } as const
