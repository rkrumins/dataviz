/**
 * Source-level scanning shared by the layout guards that jsdom cannot answer:
 * stacking contexts and backdrop-filter compositing have no representation in a
 * DOM without a compositor, so those rules are checked by reading the JSX.
 *
 * Not a parser. Just enough structure to answer "is this tag inside that one".
 */

/**
 * Comments blanked, newlines kept. Prose in this repo quotes the very classes
 * these guards forbid, so comments have to go — and collapsing a block comment
 * to nothing silently renumbers every line after it, which turns a report into
 * a wild goose chase.
 */
export const stripComments = (src: string): string =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep: string) => keep + ' '.repeat(m.length - keep.length))

export interface Tag {
  /** The whole opening tag, `<` to `>`, including every prop. */
  text: string
  name: string
  closing: boolean
  self: boolean
  pos: number
}

/**
 * The JSX tag stream in source order. `{…}` expressions are kept whole, so an
 * arrow function inside a prop cannot end a tag early and hide the className
 * that follows it.
 */
export function tagStream(src: string): Tag[] {
  const out: Tag[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue
    // `useRef<HTMLDivElement>(null)` and `Map<string, string>` look exactly like
    // an opening tag and never close, which would leave every enclosing scope
    // open for the rest of the file. A type argument always follows an
    // identifier; JSX never does.
    if (/[A-Za-z0-9_$)\]]/.test(src[i - 1] ?? ' ')) continue
    const closing = src[i + 1] === '/'
    const start = closing ? i + 2 : i + 1
    if (!/[A-Za-z]/.test(src[start] ?? '')) continue
    let depth = 0
    let quote: string | null = null
    for (let j = start; j < src.length; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') {
        depth++
      } else if (c === '}') {
        depth--
      } else if (depth === 0 && c === '>') {
        const text = src.slice(i, j + 1)
        out.push({
          text,
          name: (text.match(/^<\/?\s*([A-Za-z][\w.]*)/) ?? [])[1] ?? '',
          closing,
          self: text.endsWith('/>'),
          pos: i,
        })
        i = j
        break
      } else if (depth === 0 && c === '<') {
        i = j - 1
        break
      }
    }
  }
  return out
}

/** Leading whitespace on the line a tag starts on. */
export const indentAt = (src: string, pos: number): number =>
  src.slice(src.lastIndexOf('\n', pos - 1) + 1).match(/^[ \t]*/)![0].length

export const lineAt = (src: string, pos: number): number => src.slice(0, pos).split('\n').length

/**
 * Walks a file and calls `onDescendant` for every tag lexically inside an
 * element whose opening tag satisfies `isAncestor`.
 *
 * The tag stack alone is not trustworthy over 1,500 lines of JSX — one
 * construct it reads wrong and an ancestor's scope runs to the end of the file,
 * which is how a canvas-corner button 170 lines below a `px-6 py-3` header bar
 * was once reported as living inside it. A descendant is also indented deeper
 * than its ancestor in this codebase, every time, so both have to agree.
 */
export function walkInside(
  src: string,
  isAncestor: (tag: string) => boolean,
  onDescendant: (tag: Tag, ancestor: Tag) => void,
): void {
  const stack: string[] = []
  let at = -1
  let indent = 0
  let ancestor: Tag | null = null
  for (const t of tagStream(src)) {
    if (t.closing) {
      stack.pop()
      if (at > stack.length - 1) at = -1
      continue
    }
    if (at >= 0 && indentAt(src, t.pos) <= indent) at = -1
    if (at >= 0 && ancestor) onDescendant(t, ancestor)
    if (!t.self) {
      stack.push(t.name)
      if (at < 0 && isAncestor(t.text)) {
        at = stack.length - 1
        indent = indentAt(src, t.pos)
        ancestor = t
      }
    }
  }
}
