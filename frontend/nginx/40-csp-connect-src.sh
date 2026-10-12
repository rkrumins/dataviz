#!/bin/sh
# Widens the SPA document's ``connect-src 'self'`` by the origins in
# CSP_CONNECT_SRC (space-separated), by rewriting the map that defines
# ``$csp_connect_extra`` — see the Content-Security-Policy in
# frontend/nginx.conf and its empty default in 00-csp-connect.conf.
#
# Why it exists: an Enterprise Gateway's sign-in trigger and its
# browser-side translate call are fetches from THIS page to the corporate
# SSO host, and ``'self'`` alone blocks them before they leave the browser.
# Nothing further out can relax that — a second CSP header (the ingress)
# is enforced as the intersection of the two, so it can only tighten.
#
# Only bare https:// or wss:// origins are accepted: scheme, host,
# optional port. No path, no wildcard, no keyword, no quote, no
# semicolon. The value lands inside a security policy, so anything else
# is either a way to weaken it ('unsafe-inline', data:, http:, *) or a
# way to break it (a ``;`` starts a new directive, a quote ends nginx's
# string). Refusing is deliberate: a bad value exits non-zero, the
# official entrypoint runs these hooks under ``set -e``, and the
# container does not start — rather than serving a policy nobody wrote.
# Wildcards are refused too: the gateway calls go to a fixed, short list
# of hosts, and the admin form names each one.
#
# Unset or empty leaves the shipped default alone. CSP_CONNECT_CONF
# overrides the output path, for the test that runs this outside the
# image.
set -eu
# The list is split on whitespace below; do not let the shell also
# glob-expand a stray ``*`` into file names first.
set -f

ME=$(basename "$0")
conf="${CSP_CONNECT_CONF:-/etc/nginx/conf.d/00-csp-connect.conf}"

origins=""
for origin in ${CSP_CONNECT_SRC:-}; do
    if ! printf '%s\n' "$origin" \
        | grep -Eqx '(https|wss)://[A-Za-z0-9.-]+(:[0-9]{1,5})?'; then
        printf "%s: CSP_CONNECT_SRC: refusing '%s' — each entry must be a bare https:// or wss:// origin (scheme://host[:port], no path, wildcard, keyword, quote or semicolon), e.g. https://sso.corp.example\n" \
            "$ME" "$origin" >&2
        exit 1
    fi
    origins="$origins $origin"
done

[ -n "$origins" ] || exit 0

# ``$origins`` already starts with a space, which is what makes the
# policy read ``connect-src 'self' https://…``.
printf '# Written by %s from CSP_CONNECT_SRC at container start.\nmap $host $csp_connect_extra { default "%s"; }\n' \
    "$ME" "$origins" > "$conf"
echo "$ME: connect-src also allows:$origins"
