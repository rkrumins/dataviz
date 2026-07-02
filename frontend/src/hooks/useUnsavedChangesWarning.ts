import { useEffect } from 'react'

/**
 * Warn before the browser leaves the page while work is unsaved.
 *
 * Arms the native `beforeunload` prompt (tab close / refresh / hard
 * navigation) only while `hasUnsavedChanges` is true, and tears it down the
 * moment it flips false or the component unmounts — so a saved session never
 * triggers the browser's "Leave site?" dialog.
 *
 * Note: this covers browser-level unloads. In-app (react-router) navigation
 * doesn't fire `beforeunload`; guarding that path needs a router blocker.
 */
export function useUnsavedChangesWarning(hasUnsavedChanges: boolean): void {
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const handler = (event: BeforeUnloadEvent) => {
      // Both are needed for cross-browser coverage: preventDefault for the
      // modern spec, returnValue for the legacy Chrome/Safari path.
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsavedChanges])
}
