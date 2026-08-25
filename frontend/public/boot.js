/**
 * Pre-hydration paint. Runs synchronously, before React boots.
 *
 * These two blocks used to be inline <script> tags in index.html. They
 * are an external file now for one reason: an inline script forces the
 * document's Content-Security-Policy to carry 'unsafe-inline' on
 * script-src, which is the one directive whose whole value is that it
 * does not. Hashing them instead would work until somebody reformatted
 * the HTML and the policy silently stopped matching.
 *
 * It must stay a CLASSIC, non-deferred script. Both blocks have to run
 * before first paint — that is the entire point — and `type="module"`
 * or `defer` would move them after it, reintroducing the flashes.
 */
(function () {
  // Brand paint: apply the cached title/favicon/accent from a previous
  // visit so a rebranded deployment doesn't flash the default identity.
  // The cache is written by applyBranding() (see src/store/branding.ts);
  // the key must stay in sync with BRAND_CACHE_KEY there.
  try {
    var c = JSON.parse(localStorage.getItem('nx-brand-cache') || 'null')
    if (c) {
      if (c.title) document.title = c.title
      if (c.favicon) {
        var icon = document.querySelector("link[rel~='icon']")
        if (icon) icon.href = c.favicon
        var apple = document.querySelector("link[rel='apple-touch-icon']")
        if (apple) apple.href = c.favicon
      }
      if (c.accent) {
        document.documentElement.style.setProperty('--nx-accent-lineage', c.accent)
      }
    }
  } catch (e) { /* no-op: first visit or storage unavailable */ }

  // Theme paint: apply the persisted theme class to <html> so a cold
  // load of a route outside AppLayout (e.g. /docs, /guide — reached via
  // full page navigation, not SPA routing) doesn't flash light mode.
  // Key/shape must stay in sync with the 'nexus-preferences' zustand
  // persist store.
  try {
    var raw = localStorage.getItem('nexus-preferences')
    if (raw) {
      var theme = (JSON.parse(raw).state || {}).theme
      var isDark = theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      if (isDark) document.documentElement.classList.add('dark')
    }
  } catch (e) { /* no-op: first visit or storage unavailable */ }
})()
