import { createContext, useContext } from 'react'

export interface ViewEditorOpenOptions {
  workspaceId?: string
  dataSourceId?: string
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
