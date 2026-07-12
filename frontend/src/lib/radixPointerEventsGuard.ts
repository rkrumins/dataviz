/**
 * Global safety net for the Radix "stuck body pointer-events" freeze.
 *
 * `@radix-ui/react-dismissable-layer` sets `document.body.style.pointerEvents
 * = 'none'` while a MODAL layer (a Dialog, or a DropdownMenu with the default
 * `modal`) is open, and restores it on effect cleanup. If such a layer
 * unmounts or re-renders *while still open* — a polling parent refreshes, a
 * conditionally-rendered container hides, a route changes, or a fast
 * open/close races — the cleanup that restores the body is skipped, leaving
 * `<body>` at `pointer-events: none`. The result is the whole app becoming
 * unclickable until a full page reload.
 *
 * We can't patch Radix, and `modal={false}` only immunises one container at a
 * time (whack-a-mole — this bug has recurred). This watchdog is the app-wide
 * guarantee: it observes `<body>` (its inline style, plus its direct children
 * where Radix portals mount) and, whenever the lock is present but no Radix
 * layer is actually open, clears it — restoring interactivity within a frame.
 * It is deliberately conservative: while any Radix layer is open it never
 * touches the lock, so real overlays keep trapping clicks as intended.
 */

// A present match means a Radix layer is genuinely mounted, so the body lock
// (if any) is legitimate and must be left alone. The abnormal-unmount case that
// causes the freeze removes these nodes but leaves the lock behind.
const OPEN_LAYER_SELECTOR = [
  '[data-radix-popper-content-wrapper]', // dropdown / popover / menu / select / tooltip content
  '[role="dialog"][data-state="open"]', // Dialog
  '[role="alertdialog"][data-state="open"]', // AlertDialog
].join(', ')

function isRadixLayerOpen(): boolean {
  return document.querySelector(OPEN_LAYER_SELECTOR) !== null
}

/**
 * If `<body>` is stuck at `pointer-events: none` with no Radix layer open,
 * clear the leaked inline lock. Returns true if it healed. Exported for tests.
 */
export function healStaleBodyLock(): boolean {
  if (document.body.style.pointerEvents === 'none' && !isRadixLayerOpen()) {
    // Radix only ever sets this inline; clearing it returns to the stylesheet
    // value (interactive) without disturbing anything else.
    document.body.style.pointerEvents = ''
    return true
  }
  return false
}

let installed = false

/** Install the watchdog once, for the whole app lifetime. Idempotent. */
export function installRadixPointerEventsGuard(): void {
  if (installed || typeof document === 'undefined' || !document.body) return
  installed = true

  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    // Defer to the next frame so we evaluate AFTER Radix has finished its own
    // mount/unmount DOM work for this tick — otherwise we could momentarily see
    // a legitimately-opening modal as "not yet open" and clear its lock.
    requestAnimationFrame(() => {
      scheduled = false
      healStaleBodyLock()
    })
  }

  // The abnormal unmount removes the Radix portal (a childList change on
  // <body>) without a corresponding style change, so we watch both.
  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
  })

  // Pointer events can't reach handlers while the body is locked, so clicks
  // can't notice the freeze. Keydown (users mash Escape when stuck) and tab
  // re-focus are reliable moments to re-check.
  window.addEventListener('keydown', schedule, true)
  window.addEventListener('focus', schedule, true)
}
