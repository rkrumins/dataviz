/**
 * The one frame both right-rail drawers (an entity, a relationship) are built on, in two layers.
 *
 * `DrawerFrame` is the rail itself — it slides in and out, and lives as long as the drawer is
 * open, whatever it shows:
 * - **Keys.** It is a keyboard scope: the canvas's shortcuts never see keys typed here
 *   (Backspace is not "delete the selected node").
 * - **Focus.** When the drawer closes with focus inside, focus returns to where it came from.
 *
 * `DrawerShell` is one thing shown in it (an entity, a relationship, a connection):
 * - **Keys.** Esc leaves a text field, then closes; ⌘/Ctrl+S and ⌘/Ctrl+Enter stage the edit.
 * - **Unsaved edits.** It tells the store it is dirty; every move of the drawer is then held by
 *   the store's gate and asked about here (`UnsavedChangesDialog`) — a canvas click, the trail,
 *   Esc, a trace, the builder alike. Leaving the page asks the browser to confirm.
 * - **Focus.** When what is shown changes under the keyboard, focus goes to the new title rather
 *   than being dropped.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react'
import { motion } from 'framer-motion'
import { useCanvasStore } from '@/store/canvas'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { hasPrimaryModifier } from '@/lib/platform'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import { DrawerScrollContext, DrawerScrollSetter } from './drawerScroll'

const DRAWER_WIDTH = 'clamp(420px, 32vw, 560px)'

const FrameContext = createContext<RefObject<HTMLElement | null> | null>(null)

const isTextField = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

export function DrawerFrame({ panel, label, children }: {
  /** `data-panel` of the aside (e.g. `entity-drawer`), and its keyboard scope's name. */
  panel: string
  /** Names the drawer for assistive tech ("Entity details"). */
  label: string
  children: ReactNode
}) {
  const asideRef = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const onFocusCapture = (e: React.FocusEvent) => {
    const from = e.relatedTarget as HTMLElement | null
    if (from && !asideRef.current?.contains(from)) returnFocus.current = from
  }
  useEffect(() => () => {
    const active = document.activeElement
    const target = returnFocus.current
    if (target?.isConnected && (!active || active === document.body || !active.isConnected)) target.focus({ preventScroll: true })
  }, [])

  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  return (
    <motion.aside
      ref={asideRef}
      data-panel={panel}
      aria-label={label}
      {...keyboardScopeProps(panel)}
      onFocusCapture={onFocusCapture}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: DRAWER_WIDTH, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={MOTION.drawerSlide}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden',
        // Opaque, no backdrop-blur: the drawer pushes the canvas aside, so nothing paints behind
        // it — a blur would be invisible yet re-rasterised every frame of the width spring.
        'bg-canvas-elevated border-l border-glass-border shadow-lg shadow-black/20',
      )}
    >
      <FrameContext.Provider value={asideRef}>
        <DrawerScrollContext.Provider value={scrollEl}>
          <DrawerScrollSetter.Provider value={setScrollEl}>
            <div className="relative h-full flex flex-col overflow-hidden" style={{ width: DRAWER_WIDTH }}>
              {children}
            </div>
          </DrawerScrollSetter.Provider>
        </DrawerScrollContext.Provider>
      </FrameContext.Provider>
    </motion.aside>
  )
}

export interface DrawerShellProps {
  /** Id of the element that names what is shown (its title). */
  titleId: string
  /** What is shown — focus follows a change of it. */
  focusKey: string
  /** There are edits not staged yet. */
  dirty?: boolean
  /** Names what would be lost, for the prompt ("your changes to Orders"). */
  dirtyWhat?: ReactNode
  /** Close the drawer. The store's gate holds it while dirty. */
  onClose: () => void
  /** Stage the edit (⌘/Ctrl+S, and "Stage and continue"). */
  onStage?: () => void
  canStage?: boolean
  /** Throw the edit away — back to what is stored. */
  onDiscard?: () => void
  children: ReactNode
}

export function DrawerShell({
  titleId, focusKey, dirty = false, dirtyWhat = 'your changes', onClose, onStage, canStage = false, onDiscard, children,
}: DrawerShellProps) {
  const frame = useContext(FrameContext)
  const pending = useCanvasStore((s) => s.pendingDrawerMove)
  const asking = !!pending && dirty

  // ── Unsaved edits: the store's gate holds every move of the drawer while dirty ──
  useEffect(() => { useCanvasStore.getState().setDrawerDirty(dirty) }, [dirty])
  useEffect(() => () => useCanvasStore.getState().setDrawerDirty(false), [])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const resolve = useCanvasStore((s) => s.resolveDrawerMove)
  const stageAndGo = useCallback(() => { onStage?.(); resolve('proceed') }, [onStage, resolve])
  const discardAndGo = useCallback(() => { onDiscard?.(); resolve('proceed') }, [onDiscard, resolve])
  const keep = useCallback(() => resolve('keep'), [resolve])

  // ── Focus follows what is shown — unless the reader is working somewhere else ──
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && !frame?.current?.contains(active)) return
    document.getElementById(titleId)?.focus({ preventScroll: true })
  }, [focusKey, titleId, frame])

  // ── Keys ──
  const onKeyDown = (e: KeyboardEvent) => {
    if (asking || e.defaultPrevented) return                  // the dialog owns the keys
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (isTextField(e.target)) (e.target as HTMLElement).blur()   // first Esc leaves the field
      else onClose()
      return
    }
    if ((e.key === 's' || e.key === 'S' || e.key === 'Enter') && hasPrimaryModifier(e) && onStage && canStage) {
      e.preventDefault()
      e.stopPropagation()
      onStage()
    }
  }

  return (
    <div className="relative flex flex-col flex-1 min-h-0" onKeyDown={onKeyDown}>
      {children}
      {asking && (
        <UnsavedChangesDialog
          what={dirtyWhat}
          onStage={onStage && canStage ? stageAndGo : undefined}
          onDiscard={discardAndGo}
          onKeep={keep}
        />
      )}
    </div>
  )
}

/** The drawer's scrolling middle. */
export function DrawerBody({ children, className }: { children: ReactNode; className?: string }) {
  const setScrollEl = useContext(DrawerScrollSetter)
  return (
    <div ref={setScrollEl ?? undefined} className={cn('flex-1 min-h-0 overflow-y-auto custom-scrollbar', className)}>
      {children}
    </div>
  )
}

/** The drawer's fixed top. */
export function DrawerHeader({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={cn('flex-shrink-0 p-5 border-b border-glass-border', className)} style={style}>{children}</div>
}

/** The drawer's fixed bottom — provenance in View, the stage bar in Edit. */
export function DrawerFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex-shrink-0 px-4 py-3 border-t border-glass-border bg-canvas-elevated', className)}>{children}</div>
}
