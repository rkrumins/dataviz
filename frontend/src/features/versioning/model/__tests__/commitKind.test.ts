/** A fork's Update from parent is a commit of its own kind in history, never an "edit". */
import { describe, expect, it } from 'vitest'
import { kindMeta } from '../commitKind'

describe('kindMeta', () => {
  it('labels a sync_parent commit as an Update from parent', () => {
    expect(kindMeta('sync_parent').label).toBe('Update from parent')
  })

  it('still labels what it does not know as an edit', () => {
    expect(kindMeta('something_new').label).toBe('edit')
  })
})
