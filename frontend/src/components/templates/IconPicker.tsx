/**
 * IconPicker — curated grid of Lucide icons for template cover art.
 *
 * Limits the selection to a hand-picked set so the gallery stays visually
 * coherent. Renders icons via DynamicIcon (string → component lookup) so
 * the picked value is a plain string that round-trips through JSON cleanly.
 */
import { useState, useMemo } from 'react'
import { Search } from 'lucide-react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'

export const TEMPLATE_ICON_NAMES = [
    'Workflow', 'Layers', 'Database', 'GitBranch', 'Network', 'Boxes',
    'Sparkles', 'LayoutTemplate', 'Map', 'Package', 'Globe', 'Cloud',
    'Server', 'HardDrive', 'Cpu', 'CircuitBoard', 'Compass', 'Telescope',
    'Component', 'Combine', 'Filter', 'Funnel', 'Gauge', 'Activity',
    'BarChart3', 'PieChart', 'LineChart', 'TrendingUp', 'Target', 'Shield',
    'Lock', 'Key', 'Users', 'UserPlus', 'Building2', 'Factory',
    'BookOpen', 'Library', 'FolderTree', 'ListTree', 'Workflow', 'Route',
    'Atom', 'Beaker', 'FlaskConical', 'Microscope', 'BrainCircuit', 'Zap',
] as const

export type TemplateIconName = (typeof TEMPLATE_ICON_NAMES)[number]

interface IconPickerProps {
    value?: string
    onChange: (icon: string) => void
    accentColor?: string
}

export function IconPicker({ value, onChange, accentColor }: IconPickerProps) {
    const [query, setQuery] = useState('')

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        const unique = Array.from(new Set(TEMPLATE_ICON_NAMES))
        if (!q) return unique
        return unique.filter(name => name.toLowerCase().includes(q))
    }, [query])

    return (
        <div className="space-y-2">
            <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search icons"
                    className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md bg-canvas border border-glass-border text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/50"
                />
            </div>
            <div className="grid grid-cols-8 gap-1.5 max-h-48 overflow-y-auto custom-scrollbar p-1 rounded-md border border-glass-border bg-canvas">
                {filtered.map(name => {
                    const isActive = name === value
                    return (
                        <button
                            key={name}
                            type="button"
                            onClick={() => onChange(name)}
                            title={name}
                            className={cn(
                                'aspect-square flex items-center justify-center rounded-md border transition-all',
                                isActive
                                    ? 'border-2 shadow-sm'
                                    : 'border-transparent hover:bg-black/5 dark:hover:bg-white/5',
                            )}
                            style={isActive && accentColor ? {
                                borderColor: accentColor,
                                backgroundColor: `${accentColor}15`,
                            } : undefined}
                        >
                            <DynamicIcon
                                name={name}
                                className="w-4 h-4"
                                style={isActive && accentColor ? { color: accentColor } : undefined}
                            />
                        </button>
                    )
                })}
                {filtered.length === 0 && (
                    <div className="col-span-8 py-6 text-center text-xs text-ink-muted">
                        No icons match &ldquo;{query}&rdquo;.
                    </div>
                )}
            </div>
        </div>
    )
}
