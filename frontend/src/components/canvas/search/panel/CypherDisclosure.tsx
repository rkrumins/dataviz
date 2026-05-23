/**
 * Inline disclosure that surfaces the compiled Cypher + bound params
 * for the current draft predicate. Power-user transparency without
 * making them switch tabs.
 *
 * Was previously inlined in SearchMapPanel.tsx; extracted as part of
 * the panel rebuild.
 */
import { ChevronDown, Code2 } from 'lucide-react'
import { type FC, useState } from 'react'

import { cn } from '@/lib/utils'
import { useDraftPredicate } from '@/store/searchStore'

import { QueryStatusBar } from '../builder/QueryStatusBar'


export interface CypherDisclosureProps {
    viewId: string
}


export const CypherDisclosure: FC<CypherDisclosureProps> = ({ viewId }) => {
    const [open, setOpen] = useState(false)
    const draftPredicate = useDraftPredicate()
    const ready = draftPredicate !== null

    return (
        <div className={cn(
            "rounded-xl border transition-colors",
            open
                ? "border-glass-border bg-canvas-base/30"
                : "border-glass-border/40 bg-transparent",
        )}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className={cn(
                    "w-full flex items-center justify-between gap-3 px-3 py-2",
                    "text-left text-[11px] font-medium",
                    "text-ink-muted hover:text-ink transition-colors",
                )}
            >
                <span className="inline-flex items-center gap-2">
                    <Code2 className="w-3 h-3" strokeWidth={2.4} />
                    Compiled Cypher
                </span>
                <ChevronDown
                    className={cn(
                        "w-3 h-3 transition-transform",
                        open && "rotate-180",
                    )}
                    strokeWidth={2.4}
                />
            </button>
            {open && draftPredicate && (
                <div className="px-2 pb-2 border-t border-glass-border/40">
                    <QueryStatusBar
                        predicate={draftPredicate}
                        viewId={viewId}
                        ready={ready}
                    />
                </div>
            )}
            {open && !draftPredicate && (
                <div className="px-3 pb-3 pt-2 text-[11px] text-ink-muted leading-snug border-t border-glass-border/40">
                    Add at least one condition to see the compiled Cypher.
                </div>
            )}
        </div>
    )
}
