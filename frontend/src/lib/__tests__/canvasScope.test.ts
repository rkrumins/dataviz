import { describe, it, expect } from 'vitest'

import { canvasScopeWorkspaceId } from '../canvasScope'

describe('canvasScopeWorkspaceId — canvas versioning scope precedence', () => {
  it('prefers the view workspace when both are set (the global selection can lag)', () => {
    expect(canvasScopeWorkspaceId('ws_view', 'ws_global')).toBe('ws_view')
  })

  it('falls back to the global selection when the view has no workspace', () => {
    expect(canvasScopeWorkspaceId(null, 'ws_global')).toBe('ws_global')
    expect(canvasScopeWorkspaceId(undefined, 'ws_global')).toBe('ws_global')
  })

  it('is null when neither is set', () => {
    expect(canvasScopeWorkspaceId(null, null)).toBeNull()
    expect(canvasScopeWorkspaceId(undefined, undefined)).toBeNull()
  })
})
