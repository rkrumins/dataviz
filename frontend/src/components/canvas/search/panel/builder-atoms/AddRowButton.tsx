/**
 * AddRowButton — the small "+ Condition" trigger that opens a
 * portalled LeafPickerDropdown. Used inside group cards so users can
 * add a leaf without leaving the group.
 *
 * The button itself is intentionally compact (matches the visual
 * weight of "+ AND group" / "+ OR group" mini-buttons that sit next
 * to it in the group footer) — the heavy lifting lives in the
 * dropdown.
 */
import { ChevronDown, Plus } from 'lucide-react'
import { type FC, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { LeafPickerDropdown } from './LeafPickerDropdown'
import type { LeafKindMeta } from '../../builder/leafKinds'


export interface AddRowButtonProps {
    /** Called with a freshly-built empty predicate of the picked kind. */
    onAdd: (predicate: Predicate) => void
    disabled?: boolean
    /** Optional filter applied to the leaf list in the dropdown. */
    filter?: (meta: LeafKindMeta) => boolean
    label?: string
}


export const AddRowButton: FC<AddRowButtonProps> = ({
    onAdd, disabled, filter, label = 'Condition',
}) => {
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                className={cn(
                    'inline-flex items-center gap-1 px-2.5 py-1 rounded-md',
                    'text-[10.5px] font-medium',
                    'border border-accent-lineage/40 bg-accent-lineage/10',
                    'text-accent-lineage',
                    'hover:bg-accent-lineage/15 transition-colors',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
            >
                <Plus className="w-3 h-3" strokeWidth={2.5} />
                {label}
                <ChevronDown
                    className={cn('w-3 h-3 opacity-70 transition-transform', open && 'rotate-180')}
                    strokeWidth={2}
                />
            </button>
            <LeafPickerDropdown
                open={open}
                anchorRef={buttonRef}
                onPick={(meta) => {
                    onAdd(meta.makeEmpty())
                    setOpen(false)
                }}
                onDismiss={() => setOpen(false)}
                filter={filter}
            />
        </>
    )
}
