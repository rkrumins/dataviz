/**
 * ColorInput — shared color control: curated swatch palette + free selection
 * (native color-well and hex text field). Used by both the entity and
 * relationship type editors so the two never diverge in capability again.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** The palette both type editors used to duplicate locally. */
export const COLOR_PALETTE = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#64748b',
]

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

interface ColorInputProps {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}

export function ColorInput({ value, onChange, disabled }: ColorInputProps) {
  // Local hex text state so partial input ("#ff") doesn't propagate until valid.
  const [hexText, setHexText] = useState(value)
  useEffect(() => { setHexText(value) }, [value])

  function commitHex(text: string) {
    const normalized = text.startsWith('#') ? text : `#${text}`
    if (HEX_RE.test(normalized)) onChange(normalized.toLowerCase())
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {COLOR_PALETTE.map(color => (
          <button
            key={color}
            type="button"
            onClick={() => !disabled && onChange(color)}
            title={color}
            aria-label={`Color ${color}`}
            aria-pressed={value.toLowerCase() === color}
            className={cn(
              'w-7 h-7 rounded-lg border-2 transition-all',
              value.toLowerCase() === color
                ? 'border-ink scale-110 shadow-sm'
                : 'border-transparent hover:scale-105',
            )}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={HEX_RE.test(value) && value.length === 7 ? value : '#6366f1'}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          aria-label="Custom color"
          className="w-8 h-8 rounded-lg border border-glass-border cursor-pointer bg-transparent p-0.5"
        />
        <input
          type="text"
          value={hexText}
          onChange={e => setHexText(e.target.value)}
          onBlur={e => commitHex(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && commitHex((e.target as HTMLInputElement).value)}
          disabled={disabled}
          spellCheck={false}
          placeholder="#6366f1"
          aria-label="Hex color"
          className="w-24 px-2.5 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs font-mono text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors"
        />
        <span className="text-[10px] text-ink-muted">Custom hex</span>
      </div>
    </div>
  )
}
