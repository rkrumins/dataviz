/**
 * The provider pill (CanvasProviderStatePill), handed by CanvasRouter to a
 * canvas that shows it in its own status stack — null when there is nothing to
 * say, or when the canvas has no stack. CanvasRouter holds the retry (its
 * hydration hook is the one that loads), so the pill is built there and only
 * placed by the canvas.
 */
import { createContext, useContext, type ReactNode } from 'react'

const CanvasProviderPillContext = createContext<ReactNode>(null)

export const CanvasProviderPillSlot = CanvasProviderPillContext.Provider

export const useCanvasProviderPill = (): ReactNode => useContext(CanvasProviderPillContext)
