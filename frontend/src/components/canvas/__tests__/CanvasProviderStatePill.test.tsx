/**
 * CanvasProviderStatePill — the pill over a canvas that has data on it.
 *
 * A partial load retries on its own only for its fast attempts. After that
 * the pill must not keep promising "retrying automatically": the rest loads
 * when the reader presses Retry.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CanvasProviderStatePill } from '../CanvasProviderStateOverlay'

describe('CanvasProviderStatePill', () => {
  it('says it is retrying while it is', () => {
    render(<CanvasProviderStatePill state="slow" partial missingEntities={50} onRetry={() => {}} />)
    expect(screen.getByRole('status').textContent).toContain('retrying automatically')
  })

  it('says Retry loads the rest once it has stopped retrying on its own', () => {
    render(
      <CanvasProviderStatePill state="slow" partial missingEntities={50} retrying={false} onRetry={() => {}} />,
    )
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toContain('Retry loads the rest')
    expect(text).not.toContain('retrying automatically')
  })
})
