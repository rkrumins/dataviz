/**
 * Rows of name and value — query parameters, extra headers, argument maps.
 * A row with no name is ignored when saved.
 */
import { Plus, X } from 'lucide-react'
import { IconButton } from '@/components/ui/primitives'
import { TextField } from '@/components/admin/sso/settings/ui'
import type { Pair } from './pairs'

export function KeyValueEditor({
    label, pairs, onChange, keyPlaceholder = 'name', valuePlaceholder = 'value', addLabel = 'Add',
}: {
    label: string
    pairs: Pair[]
    onChange: (next: Pair[]) => void
    keyPlaceholder?: string
    valuePlaceholder?: string
    addLabel?: string
}) {
    const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
    return (
        <div role="group" aria-label={label} className="space-y-1.5">
            {pairs.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                    <TextField aria-label={`${label}: name ${i + 1}`} value={p.key} placeholder={keyPlaceholder}
                        onChange={e => set(i, { key: e.target.value })} />
                    <TextField aria-label={`${label}: value ${i + 1}`} value={p.value} placeholder={valuePlaceholder}
                        onChange={e => set(i, { value: e.target.value })} />
                    <IconButton icon={X} size="sm" variant="danger" label={`Remove ${p.key || 'this row'}`}
                        onClick={() => onChange(pairs.filter((_, j) => j !== i))} />
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...pairs, { key: '', value: '' }])}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            >
                <Plus className="w-3 h-3" aria-hidden /> {addLabel}
            </button>
        </div>
    )
}
