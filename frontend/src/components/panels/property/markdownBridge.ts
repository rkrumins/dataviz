/**
 * Markdown bridge for the property WYSIWYG editor.
 *
 * Single source of truth for the TipTap extension set and Markdown
 * (de)serialization. The editor is a transient ProseMirror representation —
 * values are ALWAYS read back as Markdown (`editorToMd`) so storage stays
 * Markdown-only (`html: false` forbids raw HTML round-tripping).
 *
 * The schema is deliberately locked to a small, round-trip-stable subset:
 * bold, italic, strike, inline code, code block, H1–H3, bullet/ordered/task
 * lists, blockquote, horizontal rule, hard break, and links.
 */

import { StarterKit } from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from 'tiptap-markdown'
import type { Editor } from '@tiptap/core'
import type { Extensions } from '@tiptap/core'

/** The locked extension set shared by every property editor instance. */
export function buildExtensions(placeholder?: string): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // StarterKit v3 bundles Link; keep its sensible defaults.
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: placeholder ?? 'Write…' }),
    Markdown.configure({
      html: false, // Markdown only — never accept/emit raw HTML
      tightLists: true,
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
  ]
}

/** Read the editor's content back as Markdown. */
export function editorToMd(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } }
  return storage.markdown?.getMarkdown() ?? ''
}
