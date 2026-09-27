/** The drawer's scrolling body — what a long list inside it virtualizes against. */
import { createContext, useContext } from 'react'

export const DrawerScrollContext = createContext<HTMLElement | null>(null)
export const DrawerScrollSetter = createContext<((el: HTMLElement | null) => void) | null>(null)

/** The element a drawer's body scrolls in (null outside a drawer). */
export const useDrawerScrollElement = () => useContext(DrawerScrollContext)
