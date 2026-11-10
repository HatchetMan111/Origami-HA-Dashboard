#!/usr/bin/env bash
# Runs inside the fresh container. Installs Node, the app and the systemd unit.
set -euo pipefail

PORT="${1:-8080}"
SETUP_CODE="${2:-}"
NODE_MAJOR="${3:-22}"
NODE_TARBALL="${4:-}"

export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C LANG=C
msg() { printf '\033[32m==>\033[0m %s\n' "$*"; }

CURL=(curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 15)

msg "Installing base packages …"
apt-get update -qq -o Acquire::Retries=3
apt-get install -y -qq --no-install-recommends \
  -o Acquire::Retries=3 \
  ca-certificates curl tar gzip xz-utils procps >/dev/null

arch=$(uname -m)
case $arch in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

node_bin=""
if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) -ge $NODE_MAJOR ]]; then
  node_bin=$(command -v node)
fi

if [[ -z $node_bin ]]; then
  msg "Installing Node.js ${NODE_MAJOR} …"
  tmp=$(mktemp -d)

  if [[ -n $NODE_TARBALL && -f $NODE_TARBALL ]]; then
    msg "Using the tarball pushed by the installer."
    cp "$NODE_TARBALL" "$tmp/node.tar.xz"
  else
    sums=$("${CURL[@]}" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")
    file=$(printf '%s\n' "$sums" | awk -v a="linux-${node_arch}.tar.xz" '$2 ~ a"$" {print $2; exit}' || true)
    [[ -n $file ]] || { echo "Could not resolve a Node.js tarball." >&2; exit 1; }
    if ! "${CURL[@]}" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}" -o "$tmp/node.tar.xz"; then
      printf '\033[33m!!\033[0m %s\n' "Download failed, retrying over IPv4 …"
      "${CURL[@]}" -4 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}" -o "$tmp/node.tar.xz"
    fi
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1; exit}')
    got=$(sha256sum "$tmp/node.tar.xz" | awk '{print $1}')
    [[ $want == "$got" ]] || { echo "Checksum mismatch for $file." >&2; exit 1; }
  fi

  mkdir -p /usr/local/lib/nodejs
  tar xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs
  dir=$(find /usr/local/lib/nodejs -maxdepth 1 -type d -name 'node-v*' | sort | tail -n 1)
  rm -rf "$tmp"

  if [[ -z $dir || ! -x $dir/bin/node ]]; then
    echo "Node.js archive was downloaded but no binary was found." >&2
    ls -la /usr/local/lib/nodejs >&2 || true
    echo "PATH=$PATH" >&2
    exit 1
  fi

  install -d -m 0755 /usr/local/bin
  ln -sfn "$dir/bin/node" /usr/local/bin/node
  ln -sfn "$dir/bin/npm"  /usr/local/bin/npm
  ln -sfn "$dir/bin/npx"  /usr/local/bin/npx
  printf 'export PATH="/usr/local/bin:$PATH"\n' > /etc/profile.d/node.sh
  chmod 0644 /etc/profile.d/node.sh
  node_bin="$dir/bin/node"
fi

[[ -n $NODE_TARBALL ]] && rm -f "$NODE_TARBALL"

export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
hash -r

# Use absolute paths: pct exec does not always export /usr/local/bin.
"$node_bin" -v || { echo "Node.js is not runnable at $node_bin (PATH=$PATH)" >&2; exit 1; }
npm_bin="$(dirname "$node_bin")/npm"
"$npm_bin" -v

if [[ ! -x /usr/local/bin/node ]]; then
  install -d -m 0755 /usr/local/bin
  ln -sfn "$node_bin" /usr/local/bin/node
fi
if [[ ! -x /usr/local/bin/npm ]]; then
  ln -sfn "$npm_bin" /usr/local/bin/npm
fi
if [[ ! -x /usr/local/bin/node ]]; then
  echo "/usr/local/bin/node is missing; the systemd unit would fail." >&2
  exit 1
fi

msg "Installing the app …"
install -d -m 0755 /opt/origami/app /opt/origami/data
mkdir -p /ha-config

tar xzf /root/origami-app.tgz -C /opt/origami/app

cd /opt/origami/app
"$npm_bin" install --omit=dev --no-audit --no-fund --loglevel=error \
  --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=60000

if [[ -n $SETUP_CODE ]]; then
  printf '%s\n' "$SETUP_CODE" > /opt/origami/setup-code
  chmod 600 /opt/origami/setup-code
fi

msg "Installing the service …"
install -m 0644 /root/origami.service /etc/systemd/system/origami.service
sed -i "s/^Environment=PORT=.*/Environment=PORT=${PORT}/" /etc/systemd/system/origami.service

chmod 700 /opt/origami/data
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
