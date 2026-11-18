/** Said while a large change list is still being prepared on the server and is asked for again
 *  (``changeListRetry``): a wait reads as one, not as a failure. */
export function PreparingNote() {
  return (
    <p role="status" className="text-[11.5px] text-ink-muted">
      Still preparing these changes. A large set takes a moment the first time; after that it opens at once.
    </p>
  )
}
