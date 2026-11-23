import { useLocation } from 'react-router-dom'

/** Where the router is: a test reads it after a link or a tab. */
export function Where() {
    const loc = useLocation()
    return <span data-testid="where">{loc.pathname}{loc.search}{loc.hash}</span>
}
