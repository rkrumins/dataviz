/**
 * Unified picker component for "select one or more values from a known
 * set, with free-text fallback".
 *
 * One component covers what the panel used to do with three different
 * patterns (ChipInput + datalist, KeyCombobox, native SelectField):
 *
 *  - Click the field to open a dropdown of options.
 *  - Type to filter (case-insensitive substring).
 *  - Arrow keys + Enter to pick; Escape closes.
 *  - When ``multiple={true}``, picked values appear as removable chips
 *    inside the input; backspace removes the last chip.
 *  - When the typed value doesn't match any option, the user can still
 *    pick "Use <text>" to emit it as a free-text value. This is
 *    important because discovery samples won't surface every possible
 *    value (especially right after a new property is added to the
 *    graph).
 *  - Optional value counts surfaced on each option for "how common is
 *    this value" hinting (matches discovery's tagValues map).
 *
 * Visual style: matches ``shared.tsx``'s ``fieldClass`` for input
 * surface, but the open dropdown has a heavier shadow and an
 * animated chevron, and selected options carry an accent-lineage
 * check mark.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Search, Sparkles, X } from 'lucide-react'
import {
    type CSSProperties,
    type KeyboardEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

import { fieldClass } from './shared'


// ---------------------------------------------------------------------------
// Option type
// ---------------------------------------------------------------------------

export interface PickerOption {
    /** The value emitted on selection. Always a string at the wire
     *  level — callers that want richer types coerce after picking. */
    value: string
    /** Display label. Defaults to ``value`` when omitted. */
    label?: string
    /** One-line description shown below the label in the dropdown. */
    description?: string
    /** Optional integer rendered as a small count chip next to the
     *  label (e.g. how many nodes carry this tag). */
    count?: number
    /** Optional icon — Lucide component or anything else renderable. */
    icon?: ReactNode
    /** When true, the option appears greyed out and is unselectable. */
    disabled?: boolean
}


// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BaseProps {
    options: readonly (PickerOption | string)[]
    placeholder?: string
    /** Shown in the empty dropdown when no options exist and the field
     *  is also empty. */
    emptyHint?: string
    /** Allow the user to commit a value that isn't in ``options``.
     *  Defaults to ``true`` — discovery can't see everything. */
    allowFreeText?: boolean
    /** Visual size hint — ``sm`` for inline grids, ``md`` for stand-
     *  alone editors. Defaults to ``md``. */
    size?: 'sm' | 'md'
    /** Force monospace font on the input + dropdown (good for property
     *  keys, URNs, identifiers). */
    mono?: boolean
    /** Render a search icon inside the input (subtle visual cue that
     *  the field is filterable). Defaults to ``true``. */
    showSearchIcon?: boolean
    autoFocus?: boolean
    disabled?: boolean
    className?: string
    /** Custom no-matches dropdown body. Overrides the default
     *  "No match for X. Press Enter to use it anyway." text. */
    renderNoMatches?: (query: string) => ReactNode
    /** Portal-mount the dropdown at document.body with measured
     *  positioning. Use this when the picker lives inside a narrow
     *  scroll container (e.g. the search panel rows) — otherwise the
     *  inline dropdown gets clipped against panel edges. Defaults
     *  off for backward compatibility with the existing builder. */
    portal?: boolean
}

interface SingleProps extends BaseProps {
    multiple?: false
    value: string
    onChange: (next: string) => void
}

interface MultiProps extends BaseProps {
    multiple: true
    value: readonly string[]
    onChange: (next: string[]) => void
    /** Max number of values that can be selected. Past this the
     *  dropdown disables un-selected options. */
    maxValues?: number
}

export type UnifiedPickerProps = SingleProps | MultiProps


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnifiedPicker(props: UnifiedPickerProps) {
    const {
        options,
        placeholder,
        emptyHint,
        allowFreeText = true,
        size = 'md',
        mono = false,
        showSearchIcon = true,
        autoFocus,
        disabled = false,
        className,
        renderNoMatches,
        portal = false,
    } = props

    const normalisedOptions = useMemo<PickerOption[]>(() => {
        return options.map((o) =>
            typeof o === 'string' ? { value: o } : o,
        )
    }, [options])

    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [highlightIndex, setHighlightIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const portalRef = useRef<HTMLDivElement>(null)
    const listboxId = useId()
    const [portalCoords, setPortalCoords] = useState<{
        top: number; left: number; width: number; flipped: boolean
    } | null>(null)

    // Measure + reposition the portal dropdown so it stays anchored to
    // the field and never overflows the viewport.
    useLayoutEffect(() => {
        if (!portal || !open) { setPortalCoords(null); return }
        const update = () => {
            const r = containerRef.current?.getBoundingClientRect()
            if (!r) return
            const viewportW = window.innerWidth
            const viewportH = window.innerHeight
            const width = Math.max(r.width, 240)
            const desiredH = 320
            const spaceBelow = viewportH - r.bottom
            const flipped = spaceBelow < desiredH && r.top > spaceBelow
            const top = flipped ? r.top - 4 : r.bottom + 4
            const left = Math.min(r.left, viewportW - width - 8)
            setPortalCoords({ top, left, width, flipped })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [portal, open])

    const isMultiple = props.multiple === true
    const selectedSet = useMemo<Set<string>>(() => {
        if (isMultiple) return new Set(props.value)
        return new Set([props.value])
    }, [isMultiple, props.value])

    const atMax =
        isMultiple &&
        typeof (props as MultiProps).maxValues === 'number' &&
        (props as MultiProps).value.length >= ((props as MultiProps).maxValues ?? Infinity)

    // ---------------------------------------------------------------
    // Filtering — case-insensitive substring over label/value/description
    // ---------------------------------------------------------------
    const filteredOptions = useMemo<PickerOption[]>(() => {
        const q = query.trim().toLowerCase()
        if (!q) return normalisedOptions
        return normalisedOptions.filter((o) => {
            const label = (o.label ?? o.value).toLowerCase()
            if (label.includes(q)) return true
            if (o.value.toLowerCase().includes(q)) return true
            if (o.description?.toLowerCase().includes(q)) return true
            return false
        })
    }, [normalisedOptions, query])

    // Single-select mode shows the current value (or placeholder) in
    // the field; multiple shows chips + an empty input for typing.
    const singleSelectDisplay = !isMultiple ? (props as SingleProps).value : ''

    // ---------------------------------------------------------------
    // Outside-click → close (includes the portal dropdown when active)
    // ---------------------------------------------------------------
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            const t = e.target as Node
            if (containerRef.current?.contains(t)) return
            if (portalRef.current?.contains(t)) return
            setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Clamp highlight when filtered list shrinks below it.
    useEffect(() => {
        if (highlightIndex >= filteredOptions.length) {
            setHighlightIndex(Math.max(0, filteredOptions.length - 1))
        }
    }, [filteredOptions.length, highlightIndex])

    // ---------------------------------------------------------------
    // Commit / remove helpers
    // ---------------------------------------------------------------
    const commit = useCallback((value: string) => {
        if (!value || disabled) return
        if (isMultiple) {
            const { value: current, onChange } = props as MultiProps
            if (current.includes(value)) {
                // Toggle off — common UX for multi-select.
                onChange(current.filter((v) => v !== value))
                return
            }
            if (atMax) return
            onChange([...current, value])
            setQuery('')
            setHighlightIndex(0)
            // Keep dropdown open for continued multi-selection.
            inputRef.current?.focus()
        } else {
            const { onChange } = props as SingleProps
            onChange(value)
            setQuery('')
            setOpen(false)
            inputRef.current?.blur()
        }
    }, [atMax, disabled, isMultiple, props])

    const removeChip = useCallback((value: string) => {
        if (!isMultiple) return
        const { value: current, onChange } = props as MultiProps
        onChange(current.filter((v) => v !== value))
    }, [isMultiple, props])

    // ---------------------------------------------------------------
    // Keyboard navigation
    // ---------------------------------------------------------------
    const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
        if (disabled) return
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) setOpen(true)
            setHighlightIndex((i) => Math.min(filteredOptions.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightIndex((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = filteredOptions[highlightIndex]
            if (pick && !pick.disabled) {
                commit(pick.value)
            } else if (allowFreeText && query.trim()) {
                commit(query.trim())
            }
        } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
        } else if (e.key === 'Backspace' && isMultiple && query === '') {
            const current = (props as MultiProps).value
            if (current.length > 0) {
                ;(props as MultiProps).onChange(current.slice(0, -1))
            }
        }
    }, [
        allowFreeText, commit, disabled, filteredOptions, highlightIndex,
        isMultiple, open, props, query,
    ])

    // ---------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------
    const showInput = isMultiple || open || singleSelectDisplay === ''

    return (
        <div
            ref={containerRef}
            className={cn("relative", className)}
            data-picker-open={open ? 'true' : 'false'}
        >
            <div
                className={cn(
                    fieldClass,
                    "flex items-center gap-1.5",
                    size === 'sm' && "px-2 py-1.5 text-xs",
                    disabled && "opacity-60 cursor-not-allowed",
                    open && "border-accent-lineage/50 ring-2 ring-accent-lineage/20",
                    mono && "font-mono",
                    "min-h-[34px] py-1.5",
                )}
                onMouseDown={(e) => {
                    if (disabled) return
                    // Only focus the input on container click — avoid
                    // hijacking clicks on existing chips' X buttons.
                    if ((e.target as HTMLElement).closest('[data-chip-remove]')) return
                    inputRef.current?.focus()
                    setOpen(true)
                }}
            >
                {showSearchIcon && size !== 'sm' && (
                    <Search
                        className="w-3.5 h-3.5 text-ink-muted shrink-0"
                        strokeWidth={2}
                    />
                )}

                {/* Single-select pill (when collapsed + value present). */}
                {!isMultiple && !open && singleSelectDisplay !== '' && (
                    <span
                        className={cn(
                            "truncate text-sm text-ink",
                            mono && "font-mono",
                        )}
                    >
                        {labelFor(normalisedOptions, singleSelectDisplay)}
                    </span>
                )}

                {/* Multi-select chips. */}
                {isMultiple && (props as MultiProps).value.map((v) => (
                    <Chip
                        key={v}
                        value={v}
                        label={labelFor(normalisedOptions, v)}
                        mono={mono}
                        onRemove={() => removeChip(v)}
                        disabled={disabled}
                    />
                ))}

                {showInput && (
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value)
                            if (!open) setOpen(true)
                            setHighlightIndex(0)
                        }}
                        onFocus={() => setOpen(true)}
                        onKeyDown={onKeyDown}
                        placeholder={
                            isMultiple && (props as MultiProps).value.length > 0
                                ? ''
                                : placeholder
                        }
                        autoFocus={autoFocus}
                        disabled={disabled}
                        role="combobox"
                        aria-expanded={open}
                        aria-controls={listboxId}
                        aria-autocomplete="list"
                        className={cn(
                            "flex-1 min-w-[80px] bg-transparent outline-none border-none p-0",
                            "text-sm text-ink placeholder:text-ink-muted/50",
                            mono && "font-mono",
                            disabled && "cursor-not-allowed",
                        )}
                    />
                )}

                <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Toggle dropdown"
                    onClick={() => {
                        if (disabled) return
                        setOpen((v) => !v)
                        inputRef.current?.focus()
                    }}
                    className={cn(
                        "shrink-0 p-1 rounded text-ink-muted hover:text-ink hover:bg-glass/40",
                        "transition-colors",
                    )}
                >
                    <ChevronDown
                        className={cn(
                            "w-3.5 h-3.5 transition-transform",
                            open && "rotate-180",
                        )}
                        strokeWidth={2}
                    />
                </button>
            </div>

            <UnifiedPickerDropdown
                open={open}
                portal={portal}
                portalCoords={portalCoords}
                portalRef={portalRef}
                listboxId={listboxId}
                filteredOptions={filteredOptions}
                highlightIndex={highlightIndex}
                selectedSet={selectedSet}
                atMax={atMax ?? false}
                mono={mono}
                query={query}
                allowFreeText={allowFreeText}
                emptyHint={emptyHint}
                renderNoMatches={renderNoMatches}
                onPick={(v) => commit(v)}
                onHighlight={setHighlightIndex}
            />
        </div>
    )
}


// ---------------------------------------------------------------------------
// Dropdown render — split out so portal vs inline path stays small
// ---------------------------------------------------------------------------

interface DropdownProps {
    open: boolean
    portal: boolean
    portalCoords: {
        top: number; left: number; width: number; flipped: boolean
    } | null
    portalRef: React.RefObject<HTMLDivElement | null>
    listboxId: string
    filteredOptions: PickerOption[]
    highlightIndex: number
    selectedSet: Set<string>
    atMax: boolean
    mono: boolean
    query: string
    allowFreeText: boolean
    emptyHint?: string
    renderNoMatches?: (query: string) => ReactNode
    onPick: (value: string) => void
    onHighlight: (i: number) => void
}

function UnifiedPickerDropdown({
    open, portal, portalCoords, portalRef, listboxId, filteredOptions,
    highlightIndex, selectedSet, atMax, mono, query, allowFreeText,
    emptyHint, renderNoMatches, onPick, onHighlight,
}: DropdownProps) {
    if (!open) return null

    const inner = (
        <motion.div
            ref={portal ? portalRef : undefined}
            id={listboxId}
            role="listbox"
            initial={{ opacity: 0, y: portalCoords?.flipped ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: portalCoords?.flipped ? 2 : -2 }}
            transition={{ duration: 0.12 }}
            style={portal && portalCoords ? {
                position: 'fixed',
                top: portalCoords.flipped ? undefined : portalCoords.top,
                bottom: portalCoords.flipped
                    ? (typeof window !== 'undefined' ? window.innerHeight - portalCoords.top : undefined)
                    : undefined,
                left: portalCoords.left,
                width: portalCoords.width,
                zIndex: 9999,
            } as CSSProperties : undefined}
            className={cn(
                'rounded-xl border border-glass-border',
                portal
                    ? 'bg-canvas-elevated shadow-2xl shadow-black/50'
                    : 'absolute left-0 right-0 top-full mt-1 z-30 bg-canvas-elevated/95 backdrop-blur-xl shadow-2xl shadow-black/40',
                'max-h-72 overflow-y-auto py-1 custom-scrollbar',
            )}
        >
            {filteredOptions.length === 0 ? (
                <NoMatches
                    query={query.trim()}
                    allowFreeText={allowFreeText}
                    emptyHint={emptyHint}
                    renderNoMatches={renderNoMatches}
                    onUse={() => allowFreeText && onPick(query.trim())}
                />
            ) : (
                filteredOptions.map((opt, i) => {
                    const isPicked = selectedSet.has(opt.value)
                    const isActive = i === highlightIndex
                    const isDisabled = opt.disabled || (atMax && !isPicked)
                    return (
                        <OptionRow
                            key={opt.value}
                            option={opt}
                            isPicked={isPicked}
                            isActive={isActive}
                            isDisabled={isDisabled}
                            mono={mono}
                            onClick={() => !isDisabled && onPick(opt.value)}
                            onMouseEnter={() => onHighlight(i)}
                        />
                    )
                })
            )}
        </motion.div>
    )

    if (portal) {
        if (typeof document === 'undefined' || !portalCoords) return null
        // Portal path uses a plain fragment, NOT <AnimatePresence>: a portaled
        // popover whose exit is interrupted (StrictMode double-mount, rapid
        // toggle) strands an invisible click-blocker at z-9999 over the page.
        // No AnimatePresence = instant unmount = can't strand. The inline
        // (non-portal, in-flow) path below is not a page-wide blocker, so it
        // keeps its AnimatePresence exit.
        return createPortal(<>{inner}</>, document.body)
    }
    return <AnimatePresence>{inner}</AnimatePresence>
}


// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Chip({
    value, label, mono, onRemove, disabled,
}: {
    value: string
    label: string
    mono: boolean
    onRemove: () => void
    disabled: boolean
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-md shrink-0",
                "bg-accent-lineage/15 text-accent-lineage text-xs",
                mono && "font-mono",
                disabled && "opacity-60",
            )}
        >
            <span className="truncate max-w-[140px]">{label}</span>
            {!disabled && (
                <button
                    type="button"
                    onClick={onRemove}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="hover:text-ink transition-colors"
                    aria-label={`Remove ${value}`}
                    data-chip-remove
                >
                    <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
            )}
        </span>
    )
}


function OptionRow({
    option, isPicked, isActive, isDisabled, mono, onClick, onMouseEnter,
}: {
    option: PickerOption
    isPicked: boolean
    isActive: boolean
    isDisabled: boolean
    mono: boolean
    onClick: () => void
    onMouseEnter: () => void
}) {
    return (
        <button
            type="button"
            role="option"
            aria-selected={isPicked}
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseDown={(e) => e.preventDefault()}
            disabled={isDisabled}
            className={cn(
                "w-full flex items-start gap-2 px-3 py-2 text-left transition-colors",
                isActive ? "bg-accent-lineage/15" : "hover:bg-glass/30",
                isDisabled && "opacity-50 cursor-not-allowed",
            )}
        >
            {option.icon ? (
                <span className="shrink-0 text-accent-lineage mt-0.5">{option.icon}</span>
            ) : null}
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                    <span
                        className={cn(
                            "truncate text-sm text-ink",
                            mono && "font-mono",
                            isPicked && "text-accent-lineage font-medium",
                        )}
                    >
                        {option.label ?? option.value}
                    </span>
                    {typeof option.count === 'number' && (
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-muted">
                            {option.count.toLocaleString()}
                        </span>
                    )}
                </span>
                {option.description && (
                    <span className="block text-[11px] text-ink-muted leading-snug truncate">
                        {option.description}
                    </span>
                )}
            </span>
            {isPicked && (
                <Check className="w-3.5 h-3.5 text-accent-lineage shrink-0 mt-1" strokeWidth={2.5} />
            )}
        </button>
    )
}


function NoMatches({
    query, allowFreeText, emptyHint, renderNoMatches, onUse,
}: {
    query: string
    allowFreeText: boolean
    emptyHint?: string
    renderNoMatches?: (q: string) => ReactNode
    onUse: () => void
}) {
    if (renderNoMatches) {
        return <div className="px-3 py-2">{renderNoMatches(query)}</div>
    }
    if (!query) {
        return (
            <div className="px-3 py-3 text-[11px] text-ink-muted leading-snug">
                {emptyHint ?? 'No suggestions available — type a value to use it.'}
            </div>
        )
    }
    return (
        <div className="px-3 py-2">
            <div className="text-[11px] text-ink-muted leading-snug">
                No match for <span className="font-mono text-ink">{query}</span>.
            </div>
            {allowFreeText && (
                <button
                    type="button"
                    onClick={onUse}
                    onMouseDown={(e) => e.preventDefault()}
                    className={cn(
                        "mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
                        "bg-accent-lineage/15 text-accent-lineage text-xs font-medium",
                        "hover:bg-accent-lineage/25 transition-colors",
                    )}
                >
                    <Sparkles className="w-3 h-3" strokeWidth={2.5} />
                    Use <span className="font-mono">{query}</span>
                </button>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function labelFor(options: readonly PickerOption[], value: string): string {
    const opt = options.find((o) => o.value === value)
    return opt?.label ?? value
}
