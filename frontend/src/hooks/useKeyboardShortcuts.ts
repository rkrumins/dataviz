import { useEffect, useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import { useCanvasStore } from '@/store/canvas'

type ShortcutHandler = () => void

interface ShortcutHandlers {
  openCommandPalette?: ShortcutHandler
  togglePersona?: ShortcutHandler
  saveView?: ShortcutHandler
  focusSearch?: ShortcutHandler
  deselectAll?: ShortcutHandler
  zoomToDomains?: ShortcutHandler
  zoomToApps?: ShortcutHandler
  zoomToAssets?: ShortcutHandler
  fitView?: ShortcutHandler
  toggleSidebar?: ShortcutHandler
}

/**
 * useKeyboardShortcuts - Global keyboard shortcut handler
 * 
 * Supports:
 * - Customizable key bindings
 * - Modifier keys (cmd/ctrl, shift, alt)
 * - Conflict detection
 * - Action dispatching
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const { shortcuts, toggleSidebar } = usePreferencesStore()
  const { toggleMode } = usePersonaStore()
  const { clearSelection } = useCanvasStore()
  const { fitView, zoomTo } = useReactFlow()

  /**
   * Parse a shortcut string into its components
   */
  const parseShortcut = useCallback((shortcut: string) => {
    const parts = shortcut.toLowerCase().split('+')
    return {
      mod: parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt'),
      key: parts[parts.length - 1],
    }
  }, [])

  /**
   * Check if a keyboard event matches a shortcut
   */
  const matchesShortcut = useCallback((event: KeyboardEvent, shortcut: string): boolean => {
    const parsed = parseShortcut(shortcut)
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const modPressed = isMac ? event.metaKey : event.ctrlKey

    return (
      parsed.mod === modPressed &&
      parsed.shift === event.shiftKey &&
      parsed.alt === event.altKey &&
      parsed.key === event.key.toLowerCase()
    )
  }, [parseShortcut])

  /**
   * Execute action for a shortcut
   */
  const executeAction = useCallback((action: string) => {
    switch (action) {
      case 'openCommandPalette':
        handlers.openCommandPalette?.()
        break
      case 'togglePersona':
        toggleMode()
        break
      case 'saveView':
        handlers.saveView?.()
        break
      case 'focusSearch':
        handlers.focusSearch?.()
        break
      case 'deselectAll':
        clearSelection()
        break
      case 'zoomToDomains':
        zoomTo(0.2)
        break
      case 'zoomToApps':
        zoomTo(0.6)
        break
      case 'zoomToAssets':
        zoomTo(1.2)
        break
      case 'fitView':
        fitView({ padding: 0.2 })
        break
      case 'toggleSidebar':
        toggleSidebar()
        break
    }
  }, [
    handlers, 
    toggleMode, 
    clearSelection, 
    zoomTo, 
    fitView, 
    toggleSidebar
  ])

  /**
   * Global keyboard event handler
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      // Check each registered shortcut
      for (const shortcut of shortcuts) {
        if (matchesShortcut(event, shortcut.keys)) {
          event.preventDefault()
          executeAction(shortcut.action)
          break
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts, matchesShortcut, executeAction])

  return {
    shortcuts,
    parseShortcut,
  }
}

/**
 * Format a shortcut for display
 */
export function formatShortcut(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && 
    navigator.platform.toUpperCase().indexOf('MAC') >= 0

  return shortcut
    .replace(/mod/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/cmd/gi, '⌘')
    .replace(/ctrl/gi, 'Ctrl')
    .replace(/shift/gi, '⇧')
    .replace(/alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, '')
    .split('')
    .join(' ')
}

