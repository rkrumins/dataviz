/** The text-field look every search row editor shares. */
import { cn } from '@/lib/utils'


export const inputClass = cn(
    'w-full px-3 py-2 rounded-lg',
    'bg-canvas-elevated/60 border border-glass-border',
    'text-[13px] text-ink placeholder:text-ink-muted/55',
    'focus:outline-none focus:border-accent-lineage/55',
    'focus:ring-2 focus:ring-accent-lineage/20',
    'hover:border-glass-border/80 transition-all',
)
