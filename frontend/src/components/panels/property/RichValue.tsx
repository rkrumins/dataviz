/**
 * RichValue — a property's value as it reads in a list: drawn as what it is, never as raw data.
 *
 * - yes/no as a badge, numbers grouped (and in their units where the key says one: `_ms`, `bytes`);
 * - a calendar date as a date, an instant as a time ("12 min ago", exact on hover);
 * - a link as its site and page, the full address on hover;
 * - a person's id as the person, any other id as a copyable chip, a status word as a badge;
 * - tags as chips; prose as written, Markdown formatted, long text clamped;
 * - nothing as "Not set".
 *
 * `source` shows the text as stored (the Markdown view). Read-only: editing is the row's.
 */
import { HighlightedText } from '@/components/ui/HighlightedText'
import { ValueView, drawsAsRecord } from '@/components/ui/ValueView'
import { inferFieldType } from './fieldTypes'
import { ClampedText, FormattedDate, FormattedLink, FormattedTags } from './valueWidgets'

export const NOT_SET = 'Not set'

export function RichValue({ value, fieldKey = '', query = '', source = false, onOpen }: {
  value: unknown
  /** Its key, for units (`timeout_ms`) and ids (`ownerId`). */
  fieldKey?: string
  /** Search text to highlight. */
  query?: string
  /** The text as stored, not formatted. */
  source?: boolean
  /** Open the full viewer, for long text. */
  onOpen?: (maximized?: boolean) => void
}) {
  const fieldType = inferFieldType(value)
  if (fieldType === 'none' || value === '') return <span className="text-xs text-ink-muted">{NOT_SET}</span>
  if (fieldType === 'boolean' || fieldType === 'number') {
    return <span className="text-xs"><ValueView value={value} keyHint={fieldKey} /></span>
  }
  if (fieldType === 'tags') {
    return source
      ? <span className="text-xs font-mono text-ink-muted break-all">{JSON.stringify(value)}</span>
      : <FormattedTags value={value as string[]} />
  }
  const s = String(value)
  if (source) {
    return <div className="text-xs font-mono text-ink whitespace-pre-wrap break-words"><HighlightedText text={s} query={query} /></div>
  }
  if (fieldType === 'date') return <FormattedDate value={s} />
  if (fieldType === 'url') return <FormattedLink value={s} />
  if (drawsAsRecord(s, fieldKey)) return <span className="text-xs"><ValueView value={s} keyHint={fieldKey} /></span>
  return <ClampedText text={s} onOpen={onOpen} />
}
