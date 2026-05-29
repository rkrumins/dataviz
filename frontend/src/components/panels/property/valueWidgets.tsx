/**
 * Business-friendly value widgets for the property editor.
 *
 * Each widget edits a single primitive value and emits PLAIN JSON
 * (string / number / boolean / string[]) so values persist cleanly.
 */

import { useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X as XIcon, ExternalLink, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { markdownComponents } from '@/components/docs/MarkdownComponents'
import { isIsoDate } from './fieldTypes'

// ============================================
// BooleanToggle — Yes / No switch
// ============================================

export function BooleanToggle({
  value,
  onChange,
  readOnly,
}: {
  value: boolean
  onChange: (v: boolean) => void
  readOnly?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      disabled={readOnly}
      onClick={() => !readOnly && onChange(!value)}
      className={cn(
        "inline-flex items-center gap-2 select-none",
        readOnly && "cursor-default",
      )}
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
          value ? "bg-emerald-500" : "bg-white/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            value && "translate-x-4",
          )}
        />
      </span>
      <span className={cn("text-xs font-medium", value ? "text-emerald-500" : "text-ink-muted")}>
        {value ? 'Yes' : 'No'}
      </span>
    </button>
  )
}

// ============================================
// DateField — native date picker, stores ISO YYYY-MM-DD
// ============================================

export function DateField({
  value,
  onChange,
  readOnly,
}: {
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
}) {
  const safe = isIsoDate(value) ? value : ''
  return (
    <input
      type="date"
      value={safe}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs",
        "focus:border-accent-lineage/50 focus:bg-white/8 outline-none transition-colors",
        "[color-scheme:light] dark:[color-scheme:dark]",
        readOnly && "cursor-default opacity-70",
      )}
    />
  )
}

// ============================================
// UrlField — link input with an "open" affordance
// ============================================

export function UrlField({
  value,
  onChange,
  readOnly,
}: {
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
}) {
  const trimmed = (value ?? '').trim()
  const valid = /^https?:\/\/[^\s]+$/i.test(trimmed)
  return (
    <div className="flex items-center gap-1 w-full">
      <input
        type="url"
        value={value ?? ''}
        readOnly={readOnly}
        placeholder="https://…"
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "flex-1 min-w-0 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs",
          "placeholder:text-ink-muted/50 focus:border-accent-lineage/50 focus:bg-white/8 outline-none transition-colors",
          readOnly && "cursor-default opacity-70",
        )}
      />
      {valid && (
        <a
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-accent-lineage hover:bg-white/10 transition-colors"
          title="Open link"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  )
}

// ============================================
// TagInput — chips + add-on-Enter/comma, stores string[]
// ============================================

export function TagInput({
  value,
  onChange,
  readOnly,
}: {
  value: string[]
  onChange: (v: string[]) => void
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (raw: string) => {
    const t = raw.trim()
    if (!t || value.includes(t)) { setDraft(''); return }
    onChange([...value, t])
    setDraft('')
  }

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i))

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 min-h-[2rem]",
        !readOnly && "focus-within:border-accent-lineage/50 cursor-text",
      )}
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
        >
          {tag}
          {!readOnly && (
            <button
              onClick={(e) => { e.stopPropagation(); removeAt(i) }}
              className="hover:text-red-500"
              title="Remove tag"
            >
              <XIcon className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          ref={inputRef}
          value={draft}
          placeholder={value.length ? 'Add…' : 'Type a tag, press Enter'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
            else if (e.key === 'Backspace' && draft === '' && value.length) removeAt(value.length - 1)
          }}
          onBlur={() => draft && commit(draft)}
          className="flex-1 min-w-[6rem] bg-transparent outline-none text-xs placeholder:text-ink-muted/50"
        />
      )}
    </div>
  )
}

// ============================================
// InlineMarkdown — compact formatted rendering for view mode
// ============================================

// Render single-line values inline (no block margins); only fall back to the
// full block renderer when the text is genuinely multi-line / structured.
const inlineComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}

export function InlineMarkdown({ text }: { text: string }) {
  const multiline = text.includes('\n')
  if (multiline) {
    return (
      <div className="prose-synodic max-w-none text-xs leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    )
  }
  return (
    <span className="text-xs text-ink [&_a]:text-accent-lineage [&_a]:underline [&_code]:font-mono [&_code]:text-[0.95em] [&_code]:px-1 [&_code]:rounded [&_code]:bg-black/5 dark:[&_code]:bg-white/10">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>
        {text}
      </ReactMarkdown>
    </span>
  )
}

// ============================================
// ClampedText — value-cell display that clamps heavy content + opens the modal
// ============================================

const CLAMP_CHARS = 120

export function ClampedText({
  text,
  source,
  onOpen,
  editable,
}: {
  text: string
  /** Show raw Markdown source instead of formatted. */
  source?: boolean
  /** Open the full editor/viewer modal. */
  onOpen?: () => void
  /** Edit mode — the cell is click-to-edit. */
  editable?: boolean
}) {
  const empty = text === ''
  const isLong = text.includes('\n') || text.length > CLAMP_CHARS

  const content = empty ? (
    <span className="text-xs italic text-ink-muted">{editable ? 'Empty — click to add' : 'empty'}</span>
  ) : source ? (
    <span className="text-xs font-mono text-ink whitespace-pre-wrap break-words">{text}</span>
  ) : (
    <InlineMarkdown text={text} />
  )

  const inner = (
    <div className={cn("relative", isLong && "max-h-[4.2rem] overflow-hidden")}>
      {content}
      {isLong && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-canvas-elevated to-transparent" />
      )}
    </div>
  )

  if (editable) {
    return (
      <div>
        <div
          onClick={onOpen}
          className="cursor-text rounded-md px-2 py-1 -mx-2 hover:bg-white/[0.04] transition-colors"
          title="Click to edit"
        >
          {inner}
        </div>
        {isLong && (
          <button onClick={onOpen} className="mt-0.5 text-2xs font-medium text-accent-lineage hover:underline">
            See all
          </button>
        )}
      </div>
    )
  }

  return (
    <div>
      {inner}
      {isLong && onOpen && (
        <button onClick={onOpen} className="mt-0.5 text-2xs font-medium text-accent-lineage hover:underline">
          See all
        </button>
      )}
    </div>
  )
}

// ============================================
// Formatted read-only renderers for non-text types
// ============================================

export function FormattedDate({ value }: { value: string }) {
  const d = new Date(value)
  const label = Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink">
      <Calendar className="w-3 h-3 text-rose-500" />
      {label}
    </span>
  )
}

export function FormattedLink({ value }: { value: string }) {
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-accent-lineage hover:underline break-all"
    >
      {value}
      <ExternalLink className="w-3 h-3 flex-shrink-0" />
    </a>
  )
}

export function FormattedTags({ value }: { value: string[] }) {
  if (value.length === 0) return <span className="text-xs text-ink-muted italic">none</span>
  return (
    <div className="flex flex-wrap gap-1">
      {value.map((tag, i) => (
        <span key={`${tag}-${i}`} className="px-2 py-0.5 rounded-md text-xs bg-cyan-500/15 text-cyan-600 dark:text-cyan-300">
          {tag}
        </span>
      ))}
    </div>
  )
}
