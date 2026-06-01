/**
 * ColorPicker — preset swatches matching the dataviz design tokens.
 *
 * Picks an accent color stored as a hex string on the template.
 * Constraint to a curated palette keeps the gallery visually coherent;
 * users get visual variety without hand-rolled colors clashing.
 */
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const TEMPLATE_ACCENT_COLORS = [
    { label: 'Indigo',    value: '#6366f1' },
    { label: 'Violet',    value: '#7c3aed' },
    { label: 'Fuchsia',   value: '#c026d3' },
    { label: 'Rose',      value: '#e11d48' },
    { label: 'Amber',     value: '#f59e0b' },
    { label: 'Emerald',   value: '#10b981' },
    { label: 'Cyan',      value: '#06b6d4' },
    { label: 'Slate',     value: '#475569' },
] as const

interface ColorPickerProps {
    value?: string
    onChange: (color: string) => void
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            {TEMPLATE_ACCENT_COLORS.map(({ label, value: hex }) => {
                const isActive = value?.toLowerCase() === hex.toLowerCase()
                return (
                    <button
                        key={hex}
                        type="button"
                        title={label}
                        onClick={() => onChange(hex)}
                        className={cn(
                            'w-7 h-7 rounded-full flex items-center justify-center transition-transform',
                            isActive ? 'scale-110 ring-2 ring-offset-2 ring-offset-canvas' : 'hover:scale-105',
                        )}
                        style={{
                            backgroundColor: hex,
                            ['--tw-ring-color' as string]: isActive ? hex : undefined,
                        }}
                    >
                        {isActive && <Check className="w-3.5 h-3.5 text-white" />}
                    </button>
                )
            })}
        </div>
    )
}
