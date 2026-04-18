/**
 * ReferenceModelCanvas - Backward-compatibility re-export
 *
 * The implementation has moved to ./context-view/ContextViewCanvas.tsx
 * This file preserves existing imports (e.g., CanvasRouter.tsx).
 */

export { ContextViewCanvas, ContextViewCanvas as ReferenceModelCanvas } from './context-view/ContextViewCanvas'
export { defaultReferenceModelLayers } from './context-view/constants'
export type { ContextViewCanvasProps } from './context-view/ContextViewCanvas'
export type { HierarchyNode } from '@/types/hierarchy'

import { ContextViewCanvas } from './context-view/ContextViewCanvas'
export default ContextViewCanvas
