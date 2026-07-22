import { describe, it, expect } from 'vitest'

import { canvasScopeWorkspaceId } from '../canvasScope'

describe('canvasScopeWorkspaceId — canvas versioning scope', () => {
  it('uses the view workspace when set', () => {
    expect(canvasScopeWorkspaceId('ws_view')).toBe('ws_view')
  })

  it('is null when the view has no workspace — never falls back to the global active workspace', () => {
    expect(canvasScopeWorkspaceId(null)).toBeNull()
    expect(canvasScopeWorkspaceId(undefined)).toBeNull()
  })
})
