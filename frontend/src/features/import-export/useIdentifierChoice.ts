/**
 * useIdentifierChoice — the column a file's things take their identifier from, as the person
 * chose it in `IdentifierStep` (null: the file's own, or the guess), the read with it applied
 * (`fileRows.withIdentifierColumn`), and that read's check. A new file starts from its own. The
 * import sends `read`.
 */
import { useMemo, useState } from 'react'
import { withIdentifierColumn, type FileRead } from './fileRows'
import { checkIdentifiers } from './identifierCheck'

export function useIdentifierChoice(read: FileRead | null) {
  const [column, setColumn] = useState<string | null>(null)
  const [of, setOf] = useState(read)
  if (read !== of) {
    setOf(read)
    setColumn(null)
  }
  const settled = useMemo(() => (read && column ? withIdentifierColumn(read, column) : read), [read, column])
  const check = useMemo(() => (settled ? checkIdentifiers(settled, column) : null), [settled, column])
  return { column, setColumn, read: settled, check, guessed: column === null }
}

export type IdentifierChoice = ReturnType<typeof useIdentifierChoice>
