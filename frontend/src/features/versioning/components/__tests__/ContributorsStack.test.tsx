/** ContributorsStack — who saved into a draft: a few faces, then how many more, named on hover. */
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ContributorsStack } from '../ContributorsStack'

describe('ContributorsStack', () => {
  it('shows a few of the people who saved into the draft, then how many more', () => {
    render(<ContributorsStack contributors={['a', 'b', 'c', 'd', 'e', 'f']}
      userNames={{ a: 'Ann A', b: 'Bo B', c: 'Cy C', d: 'Di D', e: 'Ed E', f: 'Flo F' }} />)
    expect(screen.getByRole('group', { name: 'Saved into this draft by Ann A, Bo B, Cy C, Di D, Ed E and Flo F' }))
      .toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('shows nothing for a draft nobody saved into yet', () => {
    const { container } = render(<ContributorsStack contributors={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
