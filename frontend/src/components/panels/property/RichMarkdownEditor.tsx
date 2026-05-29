/**
 * RichMarkdownEditor — TipTap WYSIWYG that reads/writes Markdown.
 *
 * `value` is Markdown in, `onChange` emits Markdown out (see markdownBridge —
 * `html: false` guarantees Markdown-only storage). Used inside the expand modal
 * with a static formatting toolbar.
 */

import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2,
  List, ListOrdered, ListChecks, Quote, Link as LinkIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildExtensions, editorToMd } from './markdownBridge'

interface Props {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  autoFocus?: boolean
}

function promptLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined
  const url = window.prompt('Link URL', prev ?? 'https://')
  if (url === null) return
  if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}

function ToolButton({ active, onClick, title, children }: {
  active?: boolean; onClick: () => void; title: string; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      title={title}
      className={cn(
        "w-7 h-7 flex items-center justify-center rounded-md transition-colors",
        active ? "bg-accent-lineage/20 text-accent-lineage" : "text-ink-muted hover:text-ink hover:bg-white/10",
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex items-center gap-0.5 px-1 py-1.5 border-b border-glass-border/40 flex-wrap">
      <ToolButton title="Bold (⌘B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Italic (⌘I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code className="w-3.5 h-3.5" /></ToolButton>
      <span className="w-px h-5 bg-glass-border/60 mx-1" />
      <ToolButton title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks className="w-3.5 h-3.5" /></ToolButton>
      <ToolButton title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="w-3.5 h-3.5" /></ToolButton>
      <span className="w-px h-5 bg-glass-border/60 mx-1" />
      <ToolButton title="Link (⌘K)" active={editor.isActive('link')} onClick={() => promptLink(editor)}><LinkIcon className="w-3.5 h-3.5" /></ToolButton>
    </div>
  )
}

export default function RichMarkdownEditor({ value, onChange, placeholder, autoFocus }: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Markdown we last emitted — lets the sync effect skip re-serializing the
  // editor on every keystroke (that round-trip was the source of lag).
  const lastEmitted = useRef(value)

  const editor = useEditor({
    extensions: buildExtensions(placeholder),
    content: value,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: "prose-synodic max-w-none focus:outline-none text-sm h-full overflow-y-auto custom-scrollbar px-3 py-2.5",
        // Disable native spellcheck on this (potentially very large) contenteditable —
        // the browser otherwise re-checks and repaints squiggles on text revealed during
        // scroll, which is the main cause of scroll lag on long documents.
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      },
    },
    onUpdate: ({ editor }) => {
      const md = editorToMd(editor)
      lastEmitted.current = md
      onChangeRef.current(md)
    },
  })

  // Sync the editor only when `value` changes from OUTSIDE (not from our own
  // edits). Compared against the last-emitted Markdown — no per-keystroke serialize.
  useEffect(() => {
    if (!editor) return
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [value, editor])

  if (!editor) return null

  return (
    <div className="flex flex-col h-full rounded-xl bg-black/5 dark:bg-white/[0.03] border border-white/10 overflow-hidden">
      <Toolbar editor={editor} />
      <div className="flex-1 min-h-0">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )
}
