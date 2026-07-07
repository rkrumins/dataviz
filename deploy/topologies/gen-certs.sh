#!/usr/bin/env bash
# Generate a self-signed CA + server cert/key for the FalkorDB TLS harnesses.
# Output goes to ./certs (git-ignored). Re-run to regenerate.
#
#   ./deploy/topologies/gen-certs.sh
#
# The server cert has SANs for localhost / 127.0.0.1 and the in-compose
# service names so it validates whether you connect from the host or another
# container. The integration tests default to verifyMode=none anyway.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"

if [[ -f ca.crt && -f server.crt && -f server.key ]]; then
  echo "certs already exist in $DIR (delete to regenerate)"; exit 0
fi

# CA
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=dataviz-test-ca" -out ca.crt

# Server key + CSR with SANs
openssl genrsa -out server.key 2048
cat > server.ext <<'EOF'
subjectAltName = DNS:localhost, DNS:falkordb, DNS:falkordb-master, IP:127.0.0.1
extendedKeyUsage = serverAuth, clientAuth
EOF
openssl req -new -key server.key -subj "/CN=localhost" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -sha256 -extfile server.ext

rm -f server.csr server.ext ca.srl
chmod 644 ./*.crt ./*.key
echo "Wrote ca.crt, server.crt, server.key to $DIR"
