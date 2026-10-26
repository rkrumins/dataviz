/**
 * AddClauseMenu — "+ and…": every condition that can be added where the
 * line stands, from the one catalog (vocabulary/filterKinds), searchable as
 * it's typed. Picking one adds it and opens it for its first value.
 */
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { availableCategories, ICON_TONES, type CodeKind } from '../vocabulary/filterKinds'


const JOINER_WORDS = { and: 'and…', or: 'or…', that: 'that…' } as const

export function AddClauseMenu({ joiner, relationDepth, onAdd, onOpenCode, disabled }: {
    joiner: 'and' | 'or' | 'that'
    relationDepth: number
    onAdd: (p: Predicate) => void
    onOpenCode?: (kind: CodeKind) => void
    disabled?: boolean
}) {
    const [open, setOpen] = useState(false)
    const categories = useMemo(() => availableCategories({
        relationDepth, rule: false, canCode: !!onOpenCode, canAdvanced: false,
    }), [relationDepth, onOpenCode])

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button type="button" disabled={disabled}
                        aria-label={`Add a condition (${JOINER_WORDS[joiner]})`}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
                            'text-accent-lineage/90 hover:text-accent-lineage hover:bg-accent-lineage/10',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            'disabled:opacity-50',
                        )}>
                    <Plus className="h-3.5 w-3.5" />
                    {JOINER_WORDS[joiner]}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content align="start" sideOffset={6} collisionPadding={12}
                                 onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
                                 className="z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/25 overflow-hidden">
                    <Command label="Add a condition" className="flex flex-col">
                        <Command.Input autoFocus placeholder="What should it be or have?"
                                       className="w-full border-b border-glass-border bg-transparent px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted outline-none" />
                        <Command.List className="max-h-80 overflow-y-auto custom-scrollbar p-1.5">
                            <Command.Empty className="px-3 py-6 text-center text-sm text-ink-muted">
                                Nothing by that name — try Code mode for anything else.
                            </Command.Empty>
                            {categories.map((cat) => (
                                <Command.Group key={cat.label} heading={cat.label}
                                               className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
                                    {cat.entries.map((e) => {
                                        const tone = ICON_TONES[e.tone]
                                        return (
                                            <Command.Item key={e.id} value={`${e.label} ${e.description}`}
                                                keywords={e.examples ? [...e.examples] : undefined}
                                                onSelect={() => {
                                                    setOpen(false)
                                                    if (e.action === 'code' && e.codeKind) onOpenCode?.(e.codeKind)
                                                    else if (e.build) onAdd(e.build())
                                                }}
                                                className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer data-[selected=true]:bg-accent-lineage/10">
                                                <span className={cn('mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', tone.container)}>
                                                    <e.icon className={cn('h-3.5 w-3.5', tone.icon)} />
                                                </span>
                                                <span className="flex min-w-0 flex-col">
                                                    <span className="text-sm text-ink">{e.label}</span>
                                                    <span className="text-xs text-ink-muted line-clamp-1">{e.description}</span>
                                                </span>
                                            </Command.Item>
                                        )
                                    })}
                                </Command.Group>
                            ))}
                        </Command.List>
                    </Command>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
