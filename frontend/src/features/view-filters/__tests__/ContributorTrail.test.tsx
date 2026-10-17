/**
 * The trail names each person once, in the order they shaped the view, and never
 * calls a view's first save an edit. Clicking a person filters to them without
 * opening the card underneath.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { View } from '@/services/viewApiService'
import { ContributorTrail } from '../components/ContributorTrail'
import { contributorsOf } from '../contributors'

const BASE = {
  id: 'v1', name: 'Revenue', createdAt: '2026-10-01T09:00:00+00:00', updatedAt: '2026-10-01T09:00:00.400000+00:00',
  createdBy: 'u_ada', createdByName: 'Ada Lovelace', createdByEmail: 'ada@example.com',
  updatedBy: 'u_ada', updatedByName: 'Ada Lovelace',
} as unknown as View

describe('contributorsOf', () => {
  it("doesn't call the first save an edit", () => {
    expect(contributorsOf(BASE).map(c => [c.userId, c.roles.length])).toEqual([['u_ada', 1]])
  })

  it('lists creator, editor and publisher in order, each person once', () => {
    const view = {
      ...BASE, updatedAt: '2026-10-05T09:00:00+00:00', updatedBy: 'u_alan', updatedByName: 'Alan Turing',
      dataUpdatedAt: '2026-10-06T09:00:00+00:00', dataUpdatedBy: 'u_ada', dataUpdatedByName: 'Ada Lovelace',
    } as View
    const people = contributorsOf(view)
    expect(people.map(p => p.userId)).toEqual(['u_ada', 'u_alan'])
    expect(people[0].roles[0]).toMatch(/^Created · /)
    expect(people[0].roles[1]).toMatch(/^Published its latest data · /)
    expect(people[1].roles).toEqual([expect.stringMatching(/^Last edited · /)])
  })
})

describe('ContributorTrail', () => {
  it('filters to a person without letting the click reach the card', () => {
    const onPick = vi.fn()
    const onCardClick = vi.fn()
    render(<div onClick={onCardClick}><ContributorTrail view={BASE} onPick={onPick} /></div>)
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace: Created .* Show their views/ }))
    expect(onPick).toHaveBeenCalledWith('u_ada')
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
