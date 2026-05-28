/**
 * MarkdownValueModal — premium value editor with a formatting toolbar and a
 * live side-by-side preview. Buttons insert Markdown so non-technical users
 * never type syntax. Stores plain Markdown text.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  X as XIcon,
  Copy,
  Check,
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code,
  Link as LinkIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { markdownComponents } from '@/components/docs/MarkdownComponents'

interface Edit {
  value: string
  selStart: number
  selEnd: number
}

/** Wrap the current selection with `before`/`after` (toggles nothing — pure insert). */
function wrapEdit(v: string, s: number, e: number, before: string, after: string): Edit {
  const selected = v.slice(s, e)
  const value = v.slice(0, s) + before + selected + after + v.slice(e)
  return { value, selStart: s + before.length, selEnd: e + before.length }
}

/** Prefix each line touched by the selection with `prefix`. */
function linePrefixEdit(v: string, s: number, e: number, prefix: string): Edit {
  const lineStart = v.lastIndexOf('\n', s - 1) + 1
  const lineEnd = (() => {
    const idx = v.indexOf('\n', e)
    return idx === -1 ? v.length : idx
  })()
  const block = v.slice(lineStart, lineEnd)
  const prefixed = block.split('\n').map((l) => prefix + l).join('\n')
  const value = v.slice(0, lineStart) + prefixed + v.slice(lineEnd)
  return { value, selStart: s + prefix.length, selEnd: e + prefix.length * block.split('\n').length }
}

function linkEdit(v: string, s: number, e: number): Edit {
  const selected = v.slice(s, e) || 'text'
  const snippet = `[${selected}](url)`
  const value = v.slice(0, s) + snippet + v.slice(e)
  // Select the "url" placeholder so the user can type the address immediately.
  const urlStart = s + selected.length + 3
  return { value, selStart: urlStart, selEnd: urlStart + 3 }
}

export function MarkdownValueModal({
  fieldLabel,
  value,
  readOnly,
  onSave,
  onClose,
}: {
  fieldLabel?: string
  value: string
  readOnly?: boolean
  onSave: (next: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [copied, setCopied] = useState(false)
  const [mobileTab, setMobileTab] = useState<'write' | 'preview'>('write')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pendingSel = useRef<[number, number] | null>(null)

  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0

  // Restore caret/selection after a toolbar edit re-renders the textarea.
  useLayoutEffect(() => {
    if (pendingSel.current && taRef.current) {
      const [s, e] = pendingSel.current
      taRef.current.focus()
      taRef.current.setSelectionRange(s, e)
      pendingSel.current = null
    }
  }, [draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const applyEdit = useCallback((fn: (v: string, s: number, e: number) => Edit) => {
    const ta = taRef.current
    if (!ta) return
    const { value: next, selStart, selEnd } = fn(draft, ta.selectionStart, ta.selectionEnd)
    pendingSel.current = [selStart, selEnd]
    setDraft(next)
  }, [draft])

  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); applyEdit((v, s, en) => wrapEdit(v, s, en, '**', '**')) }
    else if (k === 'i') { e.preventDefault(); applyEdit((v, s, en) => wrapEdit(v, s, en, '*', '*')) }
    else if (k === 'k') { e.preventDefault(); applyEdit(linkEdit) }
  }

  const tools: Array<{ icon: typeof Bold; title: string; run: () => void }> = [
    { icon: Bold, title: 'Bold (⌘B)', run: () => applyEdit((v, s, e) => wrapEdit(v, s, e, '**', '**')) },
    { icon: Italic, title: 'Italic (⌘I)', run: () => applyEdit((v, s, e) => wrapEdit(v, s, e, '*', '*')) },
    { icon: Strikethrough, title: 'Strikethrough', run: () => applyEdit((v, s, e) => wrapEdit(v, s, e, '~~', '~~')) },
    { icon: Code, title: 'Inline code', run: () => applyEdit((v, s, e) => wrapEdit(v, s, e, '`', '`')) },
    { icon: Heading1, title: 'Heading 1', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '# ')) },
    { icon: Heading2, title: 'Heading 2', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '## ')) },
    { icon: List, title: 'Bulleted list', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '- ')) },
    { icon: ListOrdered, title: 'Numbered list', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '1. ')) },
    { icon: ListChecks, title: 'Checklist', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '- [ ] ')) },
    { icon: Quote, title: 'Quote', run: () => applyEdit((v, s, e) => linePrefixEdit(v, s, e, '> ')) },
    { icon: LinkIcon, title: 'Link (⌘K)', run: () => applyEdit(linkEdit) },
  ]

  const preview = (
    <div className="h-full overflow-y-auto custom-scrollbar rounded-xl bg-black/5 dark:bg-white/[0.03] border border-white/10 px-4 py-3">
      {draft.trim() ? (
        <div className="prose-synodic max-w-none text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{draft}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-sm text-ink-muted italic">Nothing to preview yet.</p>
      )}
    </div>
  )

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-glass-border/50">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-ink truncate">
                {readOnly ? 'View' : 'Edit'} {fieldLabel ? <span className="font-mono text-ink-muted">{fieldLabel}</span> : 'value'}
              </h4>
              <p className="text-2xs text-ink-muted mt-0.5">{draft.length} chars · {wordCount} {wordCount === 1 ? 'word' : 'words'}</p>
            </div>
            <button onClick={onClose} className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg hover:bg-white/10" title="Close">
              <XIcon className="w-4 h-4 text-ink-muted" />
            </button>
          </div>

          {/* Toolbar */}
          {!readOnly && (
            <div className="flex items-center gap-0.5 px-4 py-2 border-b border-glass-border/40 flex-wrap">
              {tools.map((t, i) => {
                const Icon = t.icon
                const divider = i === 4 || i === 9
                return (
                  <span key={t.title} className="flex items-center">
                    {divider && <span className="w-px h-5 bg-glass-border/60 mx-1" />}
                    <button
                      onClick={t.run}
                      title={t.title}
                      className="w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </button>
                  </span>
                )
              })}
              <div className="ml-auto">
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* unavailable */ }
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 min-h-0 p-4">
            {readOnly ? (
              <div className="h-[55vh]">{preview}</div>
            ) : (
              <>
                {/* Mobile: Write/Preview tabs */}
                <div className="flex sm:hidden items-center gap-1 mb-2">
                  <button onClick={() => setMobileTab('write')} className={cn("px-3 py-1.5 rounded-lg text-xs font-medium", mobileTab === 'write' ? "bg-white/10 text-ink" : "text-ink-muted")}>Write</button>
                  <button onClick={() => setMobileTab('preview')} className={cn("px-3 py-1.5 rounded-lg text-xs font-medium", mobileTab === 'preview' ? "bg-white/10 text-ink" : "text-ink-muted")}>Preview</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 h-[55vh]">
                  <textarea
                    ref={taRef}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditorKeyDown}
                    spellCheck
                    placeholder="Write here… use the toolbar to format."
                    className={cn(
                      "h-full px-3 py-2.5 rounded-xl bg-black/10 dark:bg-white/5 border border-white/10",
                      "focus:border-accent-lineage/50 outline-none transition-colors text-sm leading-relaxed resize-none custom-scrollbar font-sans",
                      mobileTab === 'preview' && "hidden sm:block",
                    )}
                  />
                  <div className={cn(mobileTab === 'write' && "hidden sm:block", "h-full")}>{preview}</div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-glass-border/50">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/5 transition-colors">
              {readOnly ? 'Close' : 'Cancel'}
            </button>
            {!readOnly && (
              <button onClick={() => onSave(draft)} className="px-5 py-2 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 shadow-lg shadow-accent-lineage/25 transition-all">
                Save
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
