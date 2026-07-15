#!/usr/bin/env bash
# Generate TWO independent self-signed CA + server cert/key pairs for the
# split streams/cache Redis auth+TLS harness (docker-compose.redis-split-auth-tls.yml).
# Each role gets its OWN CA — proving the two roles' PKI is fully independent,
# not just their passwords. Output goes to ./certs-streams and ./certs-cache
# (git-ignored). Re-run to regenerate (idempotent — skips a set that already exists).
#
#   ./deploy/topologies/gen-split-certs.sh
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gen_one() {
  local dir="$1" cn="$2" san="$3"
  mkdir -p "$dir"
  cd "$dir"

  if [[ -f ca.crt && -f server.crt && -f server.key ]]; then
    echo "certs already exist in $dir (delete to regenerate)"
    cd "$BASE"
    return 0
  fi

  # CA
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -subj "/CN=$cn" -out ca.crt

  # Server key + CSR with SANs
  openssl genrsa -out server.key 2048
  cat > server.ext <<EOF
subjectAltName = $san
extendedKeyUsage = serverAuth, clientAuth
EOF
  openssl req -new -key server.key -subj "/CN=localhost" -out server.csr
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 3650 -sha256 -extfile server.ext

  rm -f server.csr server.ext ca.srl
  chmod 644 ./*.crt ./*.key
  echo "Wrote ca.crt, server.crt, server.key to $dir"
  cd "$BASE"
}

gen_one "$BASE/certs-streams" "dataviz-streams-test-ca" \
  "DNS:localhost, DNS:redis-streams, IP:127.0.0.1"
gen_one "$BASE/certs-cache" "dataviz-cache-test-ca" \
  "DNS:localhost, DNS:redis-cache, IP:127.0.0.1"
