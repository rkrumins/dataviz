/**
 * `heat` is optional so Analytics' range picker stays exactly as it was: no dots,
 * and the same spoken day labels. With it, a busy day gets a darker dot and its
 * count in its label.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { RangeCalendar } from '../RangeCalendar'

beforeAll(() => {
  // jsdom has no matchMedia; the calendar asks it whether two months fit.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const TODAY = '2026-10-12'

function renderCalendar(heat?: Parameters<typeof RangeCalendar>[0]['heat']) {
  return render(
    <RangeCalendar from="" to="" today={TODAY} maxSpanDays={365} onSelect={() => {}} heat={heat} />,
  )
}

const dayButton = (n: number) => screen.getAllByRole('button').find(b => b.textContent === String(n))!
const DAY_5 = new Date(Date.UTC(2026, 9, 5)).toLocaleDateString(undefined, {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

describe('RangeCalendar heat', () => {
  it('renders as before without it', () => {
    const { container } = renderCalendar()
    expect(container.querySelector('[data-heat]')).toBeNull()
    expect(dayButton(5).getAttribute('aria-label')).toBe(DAY_5)
  })

  it('shades busy days and reads their count', () => {
    const counts = new Map([['2026-10-05', 12], ['2026-10-06', 1]])
    renderCalendar({ counts, describe: n => `${n} views updated` })
    expect(dayButton(5).querySelector('[data-heat]')!.getAttribute('data-heat')).toBe('4')
    expect(dayButton(6).querySelector('[data-heat]')!.getAttribute('data-heat')).toBe('2')
    expect(dayButton(7).querySelector('[data-heat]')).toBeNull()
    expect(dayButton(5).getAttribute('aria-label')).toBe(`${DAY_5}, 12 views updated`)
  })
})
