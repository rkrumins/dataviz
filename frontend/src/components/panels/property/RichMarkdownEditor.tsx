/**
 * RichMarkdownEditor — TipTap WYSIWYG that reads/writes Markdown.
 *
 * `value` is Markdown in, `onChange` emits Markdown out (see markdownBridge —
 * `html: false` guarantees Markdown-only storage). Two variants:
 *  - `inline`: compact, no static toolbar; a BubbleMenu appears on selection.
 *  - `full`:   static formatting toolbar; used inside the expand modal.
 */

import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
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
  variant?: 'inline' | 'full'
  placeholder?: string
  autoFocus?: boolean
  onBlur?: () => void
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

export default function RichMarkdownEditor({ value, onChange, variant = 'inline', placeholder, autoFocus, onBlur }: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    extensions: buildExtensions(placeholder),
    content: value,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: cn(
          "prose-synodic max-w-none focus:outline-none",
          variant === 'inline' ? "text-xs leading-relaxed min-h-[1.5rem]" : "text-sm h-full overflow-y-auto custom-scrollbar px-3 py-2.5",
        ),
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editorToMd(editor)),
    onBlur: () => onBlur?.(),
  })

  // Keep the editor in sync when the value changes from outside (e.g. type change,
  // external reset) — but not for our own edits (guarded by the equality check).
  useEffect(() => {
    if (!editor) return
    if (value !== editorToMd(editor)) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [value, editor])

  if (!editor) return null

  if (variant === 'full') {
    return (
      <div className="flex flex-col h-full rounded-xl bg-black/5 dark:bg-white/[0.03] border border-white/10 overflow-hidden">
        <Toolbar editor={editor} />
        <div className="flex-1 min-h-0">
          <EditorContent editor={editor} className="h-full" />
        </div>
      </div>
    )
  }

  // inline
  return (
    <>
      <BubbleMenu editor={editor} className="flex items-center gap-0.5 px-1 py-1 rounded-lg border border-glass-border bg-canvas-elevated shadow-lg">
        <ToolButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="w-3.5 h-3.5" /></ToolButton>
        <ToolButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="w-3.5 h-3.5" /></ToolButton>
        <ToolButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="w-3.5 h-3.5" /></ToolButton>
        <ToolButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code className="w-3.5 h-3.5" /></ToolButton>
        <ToolButton title="Link" active={editor.isActive('link')} onClick={() => promptLink(editor)}><LinkIcon className="w-3.5 h-3.5" /></ToolButton>
      </BubbleMenu>
      <div className="px-2 py-1 rounded-md bg-white/5 border border-white/10 focus-within:border-accent-lineage/50 transition-colors">
        <EditorContent editor={editor} />
      </div>
    </>
  )
}
