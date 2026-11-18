/**
 * InlineValue — a property value edited where it is read.
 *
 * The cell reads like the View tab until it is clicked (or focused and Enter / F2 pressed); it then
 * becomes the editor its type wants, right there. Enter — or clicking away — keeps the value, which
 * the drawer stages at once; Esc puts it back. A Yes/No switch is kept the moment it flips. Long
 * text can still be opened in the full Markdown editor.
 *
 * The draft lives here, not in the drawer: until it is kept, nothing else re-renders.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Maximize2, PencilLine, X as XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { FieldType } from './fieldTypes'
import { isIsoDate, isUrl } from './fieldTypes'
import { BooleanToggle, TagInput, linkLabel } from './valueWidgets'
import { MarkdownValueModal } from './MarkdownValueEditor'

const FIELD = cn(
  'w-full min-w-0 px-2 py-1 rounded-md text-xs text-ink outline-none transition-colors',
  'bg-canvas-elevated border border-accent-lineage/50 ring-2 ring-accent-lineage/15',
  'placeholder:text-ink-muted/60',
)

/** The draft as the value it stands for, or why it can't be one. */
function parse(type: FieldType, draft: string): { value: unknown } | { error: string } {
  if (type === 'number') {
    const t = draft.trim()
    if (t === '') return { error: 'Enter a number' }
    const n = Number(t.replace(/,/g, ''))
    return Number.isFinite(n) ? { value: n } : { error: `“${t}” isn’t a number` }
  }
  if (type === 'date') {
    if (draft === '') return { value: '' }
    return isIsoDate(draft) ? { value: draft } : { error: 'Pick a date' }
  }
  return { value: draft }
}

const same = (a: unknown, b: unknown) => a === b || (Number.isNaN(a) && Number.isNaN(b))

/** Today, as the reader's own calendar has it. */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** What is being typed, read back the way it will show: a number grouped, a link by its site. */
function readBack(type: FieldType, draft: string): string | null {
  const t = draft.trim()
  if (type === 'number' && t) {
    const n = Number(t.replace(/,/g, ''))
    return Number.isFinite(n) && Math.abs(n) >= 1000 ? `Reads as ${n.toLocaleString()}` : null
  }
  if (type === 'url' && t) return isUrl(t) ? `Opens ${linkLabel(t)}` : 'Doesn’t look like a web address yet — links start https://'
  return null
}

export function InlineValue({ value, fieldType, fieldLabel, onCommit, readView }: {
  value: unknown
  fieldType: FieldType
  fieldLabel?: string
  /** Keep the value (the drawer stages it). */
  onCommit: (next: unknown) => void
  /** The value as the View tab shows it. */
  readView: ReactNode
}) {
  const [editing, setEditing] = useState(false)

  // A Yes/No is one click: kept as it flips.
  if (fieldType === 'boolean') {
    return <div className="h-6 flex items-center"><BooleanToggle value={Boolean(value)} onChange={(v) => onCommit(v)} /></div>
  }

  if (editing) {
    return fieldType === 'tags'
      ? <TagsEditor value={Array.isArray(value) ? (value as string[]) : []} onCommit={onCommit} onDone={() => setEditing(false)} />
      : <FieldEditor value={value} fieldType={fieldType} fieldLabel={fieldLabel} onCommit={onCommit} onDone={() => setEditing(false)} />
  }

  const start = (e: React.MouseEvent | KeyboardEvent) => {
    // The value's own controls (copy, expand, a link) do what they say.
    if ((e.target as HTMLElement).closest('button, a, input')) return
    setEditing(true)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit ${fieldLabel ?? 'value'}`}
      onClick={start}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); setEditing(true) }
      }}
      className={cn(
        'group/value relative flex items-start gap-1 rounded-md -mx-1.5 px-1.5 min-h-6 cursor-text transition-colors',
        'hover:bg-black/[0.035] dark:hover:bg-white/[0.05]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      )}
    >
      <div className="flex-1 min-w-0 py-0.5">{readView}</div>
      <PencilLine aria-hidden className="w-3 h-3 mt-1.5 shrink-0 text-ink-muted opacity-0 group-hover/value:opacity-100 transition-opacity" />
    </div>
  )
}

/** Text, number, date and link values: one field, kept on Enter or leaving it. */
function FieldEditor({ value, fieldType, fieldLabel, onCommit, onDone }: {
  value: unknown
  fieldType: FieldType
  fieldLabel?: string
  onCommit: (next: unknown) => void
  onDone: () => void
}) {
  const initial = value === null || value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState(false)
  const settled = useRef(false)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const multiline = fieldType === 'text' || fieldType === 'none'

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (multiline) el.setSelectionRange(el.value.length, el.value.length)
    else if (fieldType !== 'date') el.select()
  }, [multiline, fieldType])

  // Grows with what is typed, up to a few lines; then it scrolls.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !multiline) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft, multiline])

  const keep = (raw = draft) => {
    if (settled.current) return
    const parsed = parse(fieldType, raw)
    if ('error' in parsed) { setError(parsed.error); ref.current?.focus(); return }
    settled.current = true
    if (!same(parsed.value, value) && !(initial === raw && fieldType !== 'number')) onCommit(parsed.value)
    onDone()
  }
  const cancel = () => {
    settled.current = true
    onDone()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Esc puts the value back — it is not the drawer's "close".
      e.preventDefault()
      e.stopPropagation()
      cancel()
    } else if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      keep()
    }
  }

  const common = {
    value: draft,
    'aria-label': fieldLabel ?? 'Value',
    'aria-invalid': error ? true : undefined,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => { setDraft(e.target.value); setError(null) },
    onKeyDown,
    onBlur: () => { if (!modal) keep() },
  }
  // The buttons keep the field focused, so pressing one is not also "clicking away".
  const hold = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="space-y-1" data-inline-editing>
      <div className="flex items-start gap-1">
        {multiline ? (
          <textarea ref={ref} rows={1} {...common} placeholder="Type a value…" className={cn(FIELD, 'resize-none leading-relaxed custom-scrollbar')} />
        ) : (
          <input
            ref={ref}
            {...common}
            type={fieldType === 'date' ? 'date' : fieldType === 'url' ? 'url' : 'text'}
            inputMode={fieldType === 'number' ? 'decimal' : undefined}
            placeholder={fieldType === 'url' ? 'https://…' : undefined}
            className={cn(FIELD, fieldType === 'number' && 'font-mono', fieldType === 'date' && '[color-scheme:light] dark:[color-scheme:dark]',
              error && 'border-rose-500/60 ring-rose-500/15')}
          />
        )}
        <div className="flex items-center gap-0.5 shrink-0 pt-0.5">
          <HoverTip label="Keep" shortcut="↵" className="inline-flex">
            <button type="button" aria-label="Keep value" onMouseDown={hold} onClick={() => keep()}
              className="w-6 h-6 flex items-center justify-center rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10">
              <Check className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
          <HoverTip label="Put it back" shortcut="Esc" className="inline-flex">
            <button type="button" aria-label="Cancel edit" onMouseDown={hold} onClick={cancel}
              className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
          {multiline && (
            <HoverTip label="Open the full editor" detail="Formatting, lists, links" className="inline-flex">
              <button type="button" aria-label="Open full editor" onMouseDown={hold} onClick={() => setModal(true)}
                className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10">
                <Maximize2 className="w-3 h-3" />
              </button>
            </HoverTip>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-2xs text-rose-600 dark:text-rose-400 pl-0.5">{error}</p>
      ) : multiline ? (
        <p className="text-2xs text-ink-muted pl-0.5">Enter keeps · Shift+Enter new line · Esc cancels</p>
      ) : fieldType === 'date' ? (
        <div className="flex items-center gap-1 pl-0.5">
          <button type="button" onMouseDown={hold} onClick={() => { setDraft(today()); keep(today()) }}
            className="px-1.5 h-5 rounded text-2xs font-semibold text-accent-lineage hover:bg-accent-lineage/10">Today</button>
          <button type="button" onMouseDown={hold} onClick={() => { setDraft(''); keep('') }}
            className="px-1.5 h-5 rounded text-2xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10">Clear</button>
        </div>
      ) : readBack(fieldType, draft) && (
        <p aria-live="polite" className="text-2xs text-ink-muted pl-0.5 truncate">{readBack(fieldType, draft)}</p>
      )}
      {modal && (
        <MarkdownValueModal
          fieldLabel={fieldLabel}
          value={draft}
          onSave={(next) => { setModal(false); setDraft(next); keep(next) }}
          onClose={() => { setModal(false); ref.current?.focus() }}
        />
      )}
    </div>
  )
}

/** Tags: each one added or removed is kept as it is made; Done (or leaving) closes. */
function TagsEditor({ value, onCommit, onDone }: { value: string[]; onCommit: (next: unknown) => void; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.querySelector('input')?.focus() }, [])
  return (
    <div
      ref={box}
      data-inline-editing
      className="flex items-start gap-1"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone() }
      }}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) onDone() }}
    >
      <div className="flex-1 min-w-0"><TagInput value={value} onChange={(v) => onCommit(v)} /></div>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onDone}
        className="shrink-0 mt-1 px-2 h-6 rounded-md text-2xs font-semibold text-accent-lineage hover:bg-accent-lineage/10">
        Done
      </button>
    </div>
  )
}
