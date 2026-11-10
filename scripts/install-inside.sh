#!/usr/bin/env bash
# Runs inside the fresh container. Installs Node, the app and the systemd unit.
set -euo pipefail

PORT="${1:-8080}"
SETUP_CODE="${2:-}"
NODE_MAJOR="${3:-22}"

export DEBIAN_FRONTEND=noninteractive
msg() { printf '\033[32m==>\033[0m %s\n' "$*"; }

msg "Installing base packages …"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl tar gzip xz-utils procps >/dev/null

arch=$(uname -m)
case $arch in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1 || [[ $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) -lt $NODE_MAJOR ]]; then
  msg "Installing Node.js ${NODE_MAJOR} …"
  sums=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk -v a="linux-${node_arch}.tar.xz" '$2 ~ a"$" {print $2; exit}')
  [[ -n $file ]] || { echo "Could not resolve a Node.js tarball." >&2; exit 1; }
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}" -o "$tmp/node.tar.xz"
  mkdir -p /usr/local/lib/nodejs
  tar xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs
  dir=$(find /usr/local/lib/nodejs -maxdepth 1 -type d -name 'node-v*' | head -1)
  ln -sf "$dir/bin/node" /usr/local/bin/node
  ln -sf "$dir/bin/npm" /usr/local/bin/npm
  ln -sf "$dir/bin/npx" /usr/local/bin/npx
  rm -rf "$tmp"
fi

node -v
npm -v

msg "Installing the app …"
id -u origami >/dev/null 2>&1 || useradd --system --home /opt/origami --shell /usr/sbin/nologin origami
install -d -o origami -g origami /opt/origami/app /opt/origami/data
mkdir -p /ha-config

tar xzf /root/origami-app.tgz -C /opt/origami/app
chown -R origami:origami /opt/origami/app

cd /opt/origami/app
npm install --omit=dev --no-audit --no-fund --loglevel=error

if [[ -n $SETUP_CODE ]]; then
  printf '%s\n' "$SETUP_CODE" > /opt/origami/setup-code
  chmod 600 /opt/origami/setup-code
  chown origami:origami /opt/origami/setup-code
fi

msg "Installing the service …"
install -m 0644 /root/origami.service /etc/systemd/system/origami.service
sed -i "s/^Environment=PORT=.*/Environment=PORT=${PORT}/" /etc/systemd/system/origami.service

chown -R origami:origami /opt/origami
systemctl daemon-reload
systemctl enable --now origami.service

msg "Waiting for the service …"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    msg "Origami is listening on :${PORT}"
    rm -f /root/origami-app.tgz /root/install-inside.sh /root/origami.service
    exit 0
  fi
  sleep 1
done

journalctl -u origami --no-pager -n 40 || true
echo "Service did not start." >&2
exit 1
