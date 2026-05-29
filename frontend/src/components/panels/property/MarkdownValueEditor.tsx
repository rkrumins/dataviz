/**
 * MarkdownValueModal — premium value editor. Defaults to a WYSIWYG (Rich) editor
 * where you type and see formatting live; a Source toggle drops to a raw-Markdown
 * textarea with an insert-Markdown toolbar + live preview. Both modes read/write
 * Markdown, so storage stays Markdown-only.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useDeferredValue, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
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
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { markdownComponents } from '@/components/docs/MarkdownComponents'

// Lazy so TipTap (ProseMirror) code-splits out of the main bundle.
const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'))

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
  initialMode = 'rich',
  initialMaximized = false,
  onSave,
  onClose,
}: {
  fieldLabel?: string
  value: string
  readOnly?: boolean
  initialMode?: 'rich' | 'source'
  initialMaximized?: boolean
  onSave: (next: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'rich' | 'source'>(initialMode)
  const [maximized, setMaximized] = useState(initialMaximized)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [mobileTab, setMobileTab] = useState<'write' | 'preview'>('write')
  const [showPreview, setShowPreview] = useState(true)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pendingSel = useRef<[number, number] | null>(null)

  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0
  const dirty = !readOnly && draft !== value

  // Close request — guard unsaved edits behind a discard confirmation.
  const requestClose = useCallback(() => {
    if (dirty) { setConfirmDiscard(true); return }
    onClose()
  }, [dirty, onClose])

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

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

  // Render the (heavy) Markdown preview at low priority so typing stays snappy —
  // the textarea updates immediately while the preview catches up.
  const deferredDraft = useDeferredValue(draft)
  const preview = useMemo(() => (
    <div className="h-full overflow-auto custom-scrollbar rounded-xl bg-black/5 dark:bg-white/[0.03] border border-white/10 px-4 py-3">
      {deferredDraft.trim() ? (
        <div className="prose-synodic max-w-none text-sm break-words [&_pre]:overflow-x-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{deferredDraft}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-sm text-ink-muted italic">Nothing to preview yet.</p>
      )}
    </div>
  ), [deferredDraft])

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
        onClick={requestClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex flex-col border border-glass-border bg-canvas-elevated shadow-xl",
            maximized
              ? "fixed inset-3 w-auto h-auto max-w-none rounded-xl"
              : "w-[92vw] max-w-[1200px] h-[90vh] rounded-2xl",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-glass-border/50">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-ink truncate">
                {readOnly ? 'View' : 'Edit'} {fieldLabel ? <span className="font-mono text-ink-muted">{fieldLabel}</span> : 'value'}
              </h4>
              <p className="text-2xs text-ink-muted mt-0.5">{draft.length} chars · {wordCount} {wordCount === 1 ? 'word' : 'words'}</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {!readOnly && (
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/5 dark:bg-white/5">
                  {(['rich', 'source'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize",
                        mode === m ? "bg-white/10 text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              {!readOnly && (
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* unavailable */ }
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                onClick={() => setMaximized((m) => !m)}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10"
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
              >
                {maximized ? <Minimize2 className="w-4 h-4 text-ink-muted" /> : <Maximize2 className="w-4 h-4 text-ink-muted" />}
              </button>
              <button onClick={requestClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10" title="Close">
                <XIcon className="w-4 h-4 text-ink-muted" />
              </button>
            </div>
          </div>

          {/* Source-mode formatting toolbar */}
          {!readOnly && mode === 'source' && (
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
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setShowPreview((p) => !p)}
                  title={showPreview ? 'Hide preview' : 'Show preview'}
                  aria-label={showPreview ? 'Hide preview' : 'Show preview'}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
                >
                  {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {showPreview ? 'Hide preview' : 'Show preview'}
                </button>
              </div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 min-h-0 p-4">
            {readOnly ? (
              <div className="h-full">{preview}</div>
            ) : mode === 'rich' ? (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-ink-muted">Loading editor…</div>}>
                <RichMarkdownEditor value={draft} onChange={setDraft} autoFocus placeholder="Write here…" />
              </Suspense>
            ) : (
              <div className="flex flex-col h-full">
                {/* Mobile: Write/Preview tabs (only when the preview pane is on) */}
                {showPreview && (
                  <div className="flex sm:hidden items-center gap-1 mb-2 flex-shrink-0">
                    <button onClick={() => setMobileTab('write')} className={cn("px-3 py-1.5 rounded-lg text-xs font-medium", mobileTab === 'write' ? "bg-white/10 text-ink" : "text-ink-muted")}>Write</button>
                    <button onClick={() => setMobileTab('preview')} className={cn("px-3 py-1.5 rounded-lg text-xs font-medium", mobileTab === 'preview' ? "bg-white/10 text-ink" : "text-ink-muted")}>Preview</button>
                  </div>
                )}
                <div className={cn("grid gap-3 flex-1 min-h-0", showPreview ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}>
                  <textarea
                    ref={taRef}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditorKeyDown}
                    spellCheck
                    placeholder="Write here… use the toolbar to format."
                    className={cn(
                      "h-full min-w-0 px-3 py-2.5 rounded-xl bg-black/10 dark:bg-white/5 border border-white/10",
                      "focus:border-accent-lineage/50 outline-none transition-colors text-sm leading-relaxed resize-none custom-scrollbar font-sans",
                      showPreview && mobileTab === 'preview' && "hidden sm:block",
                    )}
                  />
                  {showPreview && (
                    <div className={cn(mobileTab === 'write' && "hidden sm:block", "h-full min-h-0 min-w-0")}>{preview}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-glass-border/50">
            {confirmDiscard ? (
              <>
                <span className="mr-auto text-xs text-ink-muted">Discard unsaved changes?</span>
                <button onClick={() => setConfirmDiscard(false)} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/5 transition-colors">
                  Keep editing
                </button>
                <button onClick={onClose} className="px-5 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:brightness-110 transition-all">
                  Discard
                </button>
              </>
            ) : (
              <>
                <button onClick={requestClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/5 transition-colors">
                  {readOnly ? 'Close' : 'Cancel'}
                </button>
                {!readOnly && (
                  <button onClick={() => onSave(draft)} className="px-5 py-2 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 shadow-lg shadow-accent-lineage/25 transition-all">
                    Save
                  </button>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
