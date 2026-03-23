/**
 * Views gallery — redirects to the consolidated Explorer page.
 * Kept as a route target so existing bookmarks/links to /views still work.
 */
import { Navigate } from 'react-router-dom'

export function ViewsGallery() {
  return <Navigate to="/explorer" replace />
}
