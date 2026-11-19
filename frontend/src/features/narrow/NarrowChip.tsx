/**
 * NarrowChip — the canvas says it is narrowed, and how to change that.
 *
 * A canvas showing part of a view must never pass for the whole of it: the chip
 * stays at the top for as long as the narrowing does, naming how many entities
 * it shows and what they are, with every limit the answer reached. From it the
 * narrowing can be changed, saved with the view (a short link, and what is new and
 * gone each time it is opened), exported, handed to someone else as a link, or put away.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'

import { canRetry, describeNarrow, savedText, truncationNotes } from './model'
import type { AppliedNarrow } from './narrowStore'

export interface NarrowChipProps {
  applied: AppliedNarrow
  onEdit: () => void
  onClear: () => void
  /** The narrowing as a link; absent when it is too big to carry in one. */
  link?: () => string
  /** Said with the link: what it leaves out (the starting points' names, past a length). */
  linkNote?: string
  /** Ask again — offered when the answer was cut short. */
  onRetry?: () => void
  /** Keep the narrowing as a view of its own; absent when it can't be (the
   *  preview is off, or the reader may not create views here). */
  onSaveAsView?: () => void
  /** Keep it with this view, under a name — rejects with the server's words. Absent when
   *  it can't be (no one signed in, or the preview is off). */
  onSave?: (name: string) => Promise<void>
  /** Export everything it shows, with every entity's parent and path. */
  onExport?: () => void
}

const quiet = cn(
  'pointer-events-auto inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] font-semibold',
  'text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors',
)

/** What each part of the reach added, in words. */
function breakdown(applied: AppliedNarrow): string {
  const c = applied.result.counts
  const parts = [
    `${c.seeds.toLocaleString()} ${c.seeds === 1 ? 'starting point' : 'starting points'}`,
    c.inside === null ? 'everything inside them' : c.inside ? `${c.inside.toLocaleString()} inside them` : '',
    c.upstream ? `${c.upstream.toLocaleString()} upstream` : '',
    c.downstream ? `${c.downstream.toLocaleString()} downstream` : '',
    c.partnerInside === null ? 'everything inside those' : c.partnerInside ? `${c.partnerInside.toLocaleString()} inside those` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

/** A name for it, until the reader gives one. */
function nameFor(sentence: string): string {
  const name = sentence.charAt(0).toUpperCase() + sentence.slice(1)
  return name.length > 120 ? `${name.slice(0, 119)}…` : name
}

/** Drawn over everything, under the Save button: the chip sits below the canvas's columns. */
function SaveForm({ sentence, anchor, trigger, onSave, onDone }: {
  sentence: string
  anchor: { right: number; top: number }
  trigger: React.RefObject<HTMLButtonElement | null>
  onSave: (name: string) => Promise<void>
  onDone: () => void
}) {
  const [name, setName] = useState(() => nameFor(sentence))
  const panel = useRef<HTMLDivElement>(null)
  // A click anywhere else puts it away; the Save button toggles it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) onDone()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onDone, trigger])
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }>({ kind: 'idle' })
  const save = async () => {
    if (!name.trim()) return
    setState({ kind: 'saving' })
    try {
      await onSave(name.trim())
      onDone()
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error && err.message ? err.message : 'Couldn’t save it. Try again.' })
    }
  }
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Save this narrowing"
      data-canvas-interactive
      style={{ position: 'fixed', right: anchor.right, top: anchor.top, zIndex: 1000 }}
      className={cn(
        'w-[300px] p-3 rounded-xl text-left',
        'bg-white dark:bg-neutral-900 ring-1 ring-black/10 dark:ring-white/10 shadow-xl',
      )}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone() } }}
    >
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label className="block text-[11px] font-semibold text-ink-secondary" htmlFor="narrow-save-name">Save with this view</label>
        <input
          id="narrow-save-name"
          autoFocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full h-8 px-2 rounded-lg text-[12px] bg-black/[0.04] dark:bg-white/[0.06] ring-1 ring-black/10 dark:ring-white/10 text-ink"
        />
        <p className="mt-1.5 text-[10.5px] leading-snug text-ink-muted">
          Anyone who can open this view can open it, by a short link — and see what is new and gone since.
        </p>
        {state.kind === 'failed' && <p role="alert" className="mt-1.5 text-[10.5px] leading-snug text-rose-600 dark:text-rose-400">{state.message}</p>}
        <div className="mt-2 flex justify-end gap-1">
          <button type="button" onClick={onDone} className={quiet}>Cancel</button>
          <button
            type="submit"
            disabled={state.kind === 'saving' || !name.trim()}
            className={cn(quiet, 'text-accent-lineage hover:text-accent-lineage hover:bg-accent-lineage/10 disabled:opacity-50')}
          >
            {state.kind === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

export function NarrowChip({ applied, onEdit, onClear, link, linkNote, onRetry, onSaveAsView, onSave, onExport }: NarrowChipProps) {
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState<{ right: number; top: number } | null>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const closeSave = useCallback(() => setSaving(null), [])
  const toggleSave = () => {
    const rect = saveButton.current?.getBoundingClientRect()
    setSaving((open) => (open || !rect ? null : { right: window.innerWidth - rect.right, top: rect.bottom + 8 }))
  }
  const total = applied.result.counts.total
  const notes = truncationNotes(applied.result)
  const sentence = describeNarrow(applied.spec, applied.seedsLabel)
  const saved = applied.saved

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* the clipboard refused: nothing to undo */
    }
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
      <motion.div
        role="status"
        aria-label="The canvas is narrowed"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={MOTION.modalSpring}
        className={cn(
          'pointer-events-auto flex items-center gap-3 w-full min-w-0 max-w-[640px]',
          'pl-3 pr-2 py-2 rounded-2xl backdrop-blur-xl',
          'bg-white/85 dark:bg-neutral-900/85',
          'ring-1 ring-accent-lineage/30',
          'shadow-xl shadow-black/[0.08] dark:shadow-black/50',
        )}
      >
        <span className="flex-none grid place-items-center w-7 h-7 rounded-full bg-accent-lineage/10 text-accent-lineage" aria-hidden="true">
          <LucideIcons.ScanSearch className="w-3.5 h-3.5" />
        </span>
        <HoverTip className="flex-1 min-w-0 flex" label={`Showing ${sentence}`} detail={breakdown(applied)}>
          <span className="min-w-0">
            <span className="block font-display text-[12.5px] text-ink leading-tight truncate">
              Narrowed to <strong className="font-semibold tabular-nums">{total.toLocaleString()}</strong> {total === 1 ? 'entity' : 'entities'}
            </span>
            <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-tight truncate" data-narrow-saved={saved ? saved.id : undefined}>
              {saved ? savedText(saved) : sentence}
            </span>
          </span>
        </HoverTip>
        {notes.length > 0 && (
          <HoverTip className="flex" label="Not everything it reaches is shown" detail={notes.join(' ')}>
            <span className="grid place-items-center w-7 h-7 rounded-lg text-amber-600 dark:text-amber-400" aria-label="Not everything it reaches is shown">
              <LucideIcons.TriangleAlert className="w-3.5 h-3.5" />
            </span>
          </HoverTip>
        )}
        <span className="flex items-center gap-0.5 flex-none">
          {onRetry && canRetry(applied.result) && (
            <button type="button" onClick={onRetry} className={quiet}>
              <LucideIcons.RotateCw className="w-3 h-3" aria-hidden="true" />
              Try again
            </button>
          )}
          <button type="button" onClick={onEdit} className={quiet}>
            <LucideIcons.SlidersHorizontal className="w-3 h-3" aria-hidden="true" />
            Edit
          </button>
          {onSave && !saved && (
            <span className="relative flex">
              <HoverTip className="flex" label="Save this narrowing" detail="Keep it with this view for everyone who can open it, under a short link.">
                <button ref={saveButton} type="button" onClick={toggleSave} className={quiet} aria-expanded={!!saving}>
                  <LucideIcons.Bookmark className="w-3 h-3 text-accent-lineage" aria-hidden="true" />
                  Save
                </button>
              </HoverTip>
              {saving && <SaveForm sentence={sentence} anchor={saving} trigger={saveButton} onSave={onSave} onDone={closeSave} />}
            </span>
          )}
          {onSaveAsView && (
            <HoverTip className="flex" label="Save as a view" detail="Keep this as a view of its own on the same data, to share — kept up to date, or as it is now.">
              <button type="button" onClick={onSaveAsView} className={quiet}>
                <LucideIcons.BookmarkPlus className="w-3 h-3 text-accent-lineage" aria-hidden="true" />
                Save as view
              </button>
            </HoverTip>
          )}
          {onExport && (
            <HoverTip className="flex" label="Export what it shows" detail="Every entity with its parent and path, and the flows between them — as CSV, NDJSON or JSON.">
              <button type="button" onClick={onExport} className={quiet} aria-label="Export">
                <LucideIcons.Download className="w-3 h-3" aria-hidden="true" />
              </button>
            </HoverTip>
          )}
          <HoverTip
            className="flex"
            label={link ? (saved ? 'Copy its short link' : 'Copy a link to this narrowing') : 'Too long for a link'}
            detail={link
              ? `It opens the view narrowed the same way, on the data as it is then.${linkNote ? ` ${linkNote}` : ''}`
              : onSave ? 'Save it with the view for a short link.' : 'Narrow from a search instead: a link carries the search.'}
          >
            <button type="button" onClick={copy} disabled={!link} className={cn(quiet, 'disabled:opacity-40 disabled:pointer-events-none')} aria-label="Copy link">
              {copied ? <LucideIcons.Check className="w-3 h-3 text-emerald-500" /> : <LucideIcons.Link className="w-3 h-3" />}
              {copied ? 'Copied' : 'Link'}
            </button>
          </HoverTip>
          <button
            type="button"
            onClick={onClear}
            className={cn(quiet, 'text-accent-lineage hover:text-accent-lineage hover:bg-accent-lineage/10')}
          >
            <LucideIcons.X className="w-3 h-3" aria-hidden="true" />
            Show everything
          </button>
        </span>
      </motion.div>
    </div>
  )
}
