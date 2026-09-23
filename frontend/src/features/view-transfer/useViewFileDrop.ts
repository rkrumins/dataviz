/**
 * Drop a view file anywhere on a page to import it.
 *
 * Returns handlers to spread on the page's root element and whether a file is over it;
 * `ViewFileDropOverlay` shows where to let go. Only drags carrying files count, and only over
 * the page itself: dialogs portaled out of the page (whose events still bubble through the React
 * tree) are not part of the drop target.
 */
import { useCallback, useRef, useState, type DragEvent } from 'react'

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function insidePage(e: DragEvent): boolean {
  return (e.currentTarget as Node).contains(e.target as Node)
}

export function useViewFileDrop(onFile: (file: File) => void, enabled = true) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!enabled || !carriesFiles(e) || !insidePage(e)) return
    depth.current += 1
    setDragging(true)
  }, [enabled])

  const onDragOver = useCallback((e: DragEvent) => {
    if (enabled && carriesFiles(e) && insidePage(e)) e.preventDefault()
  }, [enabled])

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!enabled || !carriesFiles(e) || !insidePage(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [enabled])

  const onDrop = useCallback((e: DragEvent) => {
    if (!enabled || !carriesFiles(e) || !insidePage(e)) return
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && /\.json$/i.test(file.name)) onFile(file)
  }, [enabled, onFile])

  return { dragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
