import { CornerDownRight } from 'lucide-react'

/** FollowUpChips — questions that pick up where the answer left off; a click asks it. */
export function FollowUpChips({ items, onAsk, disabled = false }: {
    items: string[]
    onAsk: (question: string) => void
    disabled?: boolean
}) {
    if (items.length === 0) return null
    return (
        <div role="group" aria-label="Follow-up questions" className="flex flex-wrap gap-1.5">
            {items.map((q) => (
                <button
                    key={q}
                    type="button"
                    disabled={disabled}
                    onClick={() => onAsk(q)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent-lineage/25 bg-accent-lineage/5 px-2.5 py-1 text-left text-xs font-medium text-accent-lineage transition-colors hover:border-accent-lineage/50 hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:opacity-50"
                >
                    <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">{q}</span>
                </button>
            ))}
        </div>
    )
}
