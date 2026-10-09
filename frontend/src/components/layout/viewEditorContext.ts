import { createContext, useContext } from 'react'

export interface ViewEditorOpenOptions {
  workspaceId?: string
  dataSourceId?: string
  /** 'import' opens the wizard on the Import journey (a view from a file) instead of building. */
  journey?: 'build' | 'import'
  /** Import journey: a file already chosen, e.g. dropped on the Explorer. */
  importFile?: File
  /** Import journey: update this view from a file. */
  importIntoViewId?: string
}

export interface ViewEditorContextType {
  openViewEditor: (viewId?: string, options?: ViewEditorOpenOptions) => void
  closeViewEditor: () => void
}

export const ViewEditorContext = createContext<ViewEditorContextType | null>(null)

export function useViewEditorModal(): ViewEditorContextType {
  const context = useContext(ViewEditorContext)
  if (!context) {
    throw new Error('useViewEditorModal must be used within AppLayout')
  }
  return context
}
