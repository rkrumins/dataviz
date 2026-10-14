/**
 * People replaced the Creator dropdown. The role is part of the question — "views
 * Ada edited" is not "views Ada created" — so these pin that the role switch and
 * the counts agree, that you are always first and stored as "me", and that an old
 * "created by <your id>" link still shows as You.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PeopleFilterMenu } from '../components/PeopleFilterMenu'
import { peopleFromFacets, type PersonOption } from '../people'

const PEOPLE: PersonOption[] = [
  { userId: 'u_ada', displayName: 'Ada Lovelace', email: 'ada@example.com', count: 5, createdCount: 4, editedCount: 2, publishedCount: 9 },
  { userId: 'u_me', displayName: 'Me Myself', email: 'me@example.com', count: 3, createdCount: 3, editedCount: 1, publishedCount: 0 },
  { userId: 'u_bob', displayName: 'Bob Builder', email: 'bob@example.com', count: 1, createdCount: 0, editedCount: 1, publishedCount: 0 },
]
const ME = { id: 'u_me', name: 'Me Myself', email: 'me@example.com' }

/** The option rows — not the trigger, which also names the selection. */
function personRows() {
  return screen.getAllByRole('button')
    .filter(b => !b.hasAttribute('aria-haspopup') && /You|Ada|Bob/.test(b.textContent ?? ''))
}

function setup(props: Partial<React.ComponentProps<typeof PeopleFilterMenu>> = {}) {
  const onChange = vi.fn()
  render(
    <PeopleFilterMenu ids={[]} role={null} people={PEOPLE} currentUser={ME} onChange={onChange} {...props} />,
  )
  return { onChange }
}

describe('PeopleFilterMenu', () => {
  it('pins You first and stores you as "me"', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByRole('button', { name: /people/i }))
    const rows = personRows()
    expect(within(rows[0]).getByText('You')).toBeTruthy()
    // Your own row isn't listed twice.
    expect(screen.queryAllByText('Me Myself').length).toBe(1)
    await user.click(rows[0])
    expect(onChange).toHaveBeenCalledWith({ ids: ['me'], role: null })
  })

  it('counts by the chosen role, and switching role keeps the people', async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ ids: ['u_ada'], role: 'published' })
    await user.click(screen.getByRole('button', { name: /Ada Lovelace · published/ }))
    expect(screen.getByLabelText('9 views')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Edited' }))
    expect(onChange).toHaveBeenCalledWith({ ids: ['u_ada'], role: 'edited' })
  })

  it('shows an old "created by <your id>" link as You', async () => {
    const user = userEvent.setup()
    setup({ ids: ['u_me'], role: 'created' })
    const trigger = screen.getByRole('button', { name: /You · created/ })
    await user.click(trigger)
    const rows = personRows()
    // Selected: the row carries the check, and there's no second "Me Myself" row.
    expect(within(rows[0]).getByText('You')).toBeTruthy()
    expect(rows[0].querySelector('svg.text-rose-500')).toBeTruthy()
    expect(screen.queryAllByText('Me Myself').length).toBe(1)
  })

  it('summarises several people on the trigger', () => {
    setup({ ids: ['u_ada', 'u_bob'], role: 'edited' })
    expect(screen.getByRole('button', { name: /Ada Lovelace \+1 · edited/ })).toBeTruthy()
  })
})

describe('peopleFromFacets', () => {
  it('falls back to creators on a server without the People facet', () => {
    const people = peopleFromFacets({
      tags: [], viewTypes: [],
      creators: [{ userId: 'u1', displayName: 'One', count: 2 }],
    })
    expect(people).toEqual([{
      userId: 'u1', displayName: 'One', email: null, avatarId: null,
      count: 2, createdCount: 2, editedCount: 0, publishedCount: 0,
    }])
  })
})
