#!/usr/bin/env bash
# Origami-LXC – installs the Origami setup appliance as a Proxmox LXC.
# Usage: bash install/origami.sh [options]
set -Eeuo pipefail

REPO="${ORIGAMI_LXC_REPO:-HatchetMan111/Origami-HA-Dashboard}"
REF="${ORIGAMI_LXC_REF:-main}"

CTID=""
CT_HOSTNAME="origami"
CORES=2
RAM=2048
DISK=8
STORAGE=""
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
BRIDGE="vmbr0"
BRIDGE_SET=0
IP="dhcp"
GATEWAY=""
HA_CONFIG=""
PORT=8080
DRY_RUN=0
ASSUME_YES=0
CHECK=0
PAYLOAD=""
NODE_TARBALL=""
NODE_MAJOR=22

C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'

# shellcheck disable=SC2154  # rc is assigned inside the trap
trap 'rc=$?; rm -f "${PAYLOAD:-}" "${NODE_TARBALL:-}"; printf "%s\n" "${C_R}xx ${C_0}Unerwarteter Fehler (Exit $rc) in Zeile $LINENO: $BASH_COMMAND" >&2' ERR

msg()  { printf '%s\n' "${C_G}==>${C_0} ${C_B}$*${C_0}"; }
warn() { printf '%s\n' "${C_Y}!! ${C_0}$*"; }
die()  { printf '%s\n' "${C_R}xx ${C_0}$*" >&2; exit 1; }

usage() {
  cat <<EOF
${C_B}Origami-LXC${C_0} – Origami dashboard setup appliance for Home Assistant

  bash install/origami.sh [options]

  --id <100-999>        container id (default: next free from 100)
  --hostname <name>     container hostname (default: origami)
  --ip <addr/cidr|dhcp> static address (default: dhcp)
  --gw <addr>           gateway for a static address
  --bridge <name>       network bridge (default: vmbr0)
  --cores <n>           CPU cores (default: 2)
  --ram <mb>            memory (default: 2048)
  --disk <gb>           root disk (default: 8)
  --storage <name>      PVE storage for the root disk
  --template-storage <name>  PVE storage for LXC templates (default: local)
  --ha-config <path>    host path with Home Assistant's /config (bind mount)
  --port <n>            web port inside the container (default: 8080)
  --dry-run             print what would happen, change nothing
  --check               only show host storage/template diagnostics, then exit
  --yes                 do not ask for confirmation
  -h, --help            this text

  Environment: ORIGAMI_LXC_REPO (owner/repo), ORIGAMI_LXC_REF (branch/tag)
EOF
}

need_root() { [[ ${EUID:-0} -eq 0 ]] || die "Please run as root on the Proxmox host."; }

check_host() {
  command -v pct  >/dev/null || die "pct not found – is this a Proxmox VE host?"
  command -v pveam >/dev/null || die "pveam not found – is this a Proxmox VE host?"
  [[ -d /etc/pve ]] || die "/etc/pve not found – is this a Proxmox VE host?"
}

next_id() {
  local id=100
  while id_in_use "$id"; do id=$((id + 1)); done
  printf '%s' "$id"
}

id_in_use() {
  local id=$1
  pct status "$id" >/dev/null 2>&1 && return 0
  command -v qm >/dev/null 2>&1 && qm status "$id" >/dev/null 2>&1 && return 0
  compgen -G "/etc/pve/nodes/*/qemu/${id}.conf" >/dev/null && return 0
  compgen -G "/etc/pve/nodes/*/lxc/${id}.conf" >/dev/null && return 0
  return 1
}

pick_bridge() {
  local bridges
  bridges=$(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | sort -u || true)
  if [[ -n $bridges ]] && grep -qx 'vmbr0' <<<"$bridges"; then
    printf 'vmbr0'
    return
  fi
  if [[ -n $bridges ]]; then
    printf '%s\n' "$bridges" | sed -n '1p'
    return
  fi
  printf 'vmbr0'
}

pick_storage() {
  if [[ -n $STORAGE ]]; then printf '%s' "$STORAGE"; return; fi

  local list
  list=$(pvesm status --content rootdir 2>/dev/null | awk 'NR > 1 && $1 != "Name" {print $1}' || true)
  if [[ -z $list ]]; then
    # Fall back to any storage that is not the template/ISO storage.
    list=$(pvesm status 2>/dev/null | awk 'NR > 1 {print $1}' | grep -vx 'local' || true)
  fi
  if [[ -z $list ]]; then
    list=$(pvesm status 2>/dev/null | awk 'NR > 1 {print $1}' || true)
  fi

  local name
  for name in local-lvm local-zfs local; do
    if grep -qx "$name" <<<"$list"; then printf '%s' "$name"; return; fi
  done
  printf '%s' "$(printf '%s\n' "$list" | sed '/^$/d' | sed -n '1p')"
}

pick_template_storage() {
  if [[ -n ${TEMPLATE_STORAGE:-} ]]; then printf '%s' "$TEMPLATE_STORAGE"; return; fi

  local list
  list=$(pvesm status --content vztmpl 2>/dev/null | awk 'NR > 1 && $1 != "Name" {print $1}' || true)
  if [[ -z $list ]]; then
    list=$(pvesm status 2>/dev/null | awk 'NR > 1 {print $1}' || true)
  fi

  if grep -qx 'local' <<<"$list"; then printf 'local'; return; fi
  printf '%s' "$(printf '%s\n' "$list" | sed '/^$/d' | sed -n '1p')"
}

ensure_template() {
  local storage=$1
  [[ -n $storage ]] || die "Kein Storage für LXC-Templates gefunden. Prüfe Datacenter → Storage → Content (vztmpl)."
  if ! pveam list "$storage" >/dev/null 2>&1; then
    die "Storage '$storage' unterstützt keine LXC-Templates oder ist nicht erreichbar. Nutze --template-storage <name>."
  fi

  local template
  template=$(pveam list "$storage" 2>/dev/null | awk '/debian-13-standard/ {print $1; exit}' || true)
  [[ -n $template ]] && { printf '%s' "$template"; return; }
  template=$(pveam list "$storage" 2>/dev/null | awk '/debian-12-standard/ {print $1; exit}' || true)
  [[ -n $template ]] && { printf '%s' "$template"; return; }

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '%s:<debian-13-standard>' "$storage"
    return
  fi

  warn "No Debian template found, downloading one …"
  pveam update >/dev/null
  local name
  name=$(pveam available --section system 2>/dev/null | awk '/debian-13-standard/ {print $NF; exit}' || true)
  [[ -z $name ]] && name=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $NF; exit}' || true)
  [[ -n $name ]] || die "No Debian template available. Run 'pveam update' and try again."
  pveam download "$storage" "$name" >/dev/null
  template=$(pveam list "$storage" 2>/dev/null | awk -v n="$name" '$1 ~ n"$" {print $1; exit}' || true)
  [[ -n $template ]] || die "Template $name was downloaded but not found in $storage."
  printf '%s' "$template"
}

create_ct() {
  local id=$1 tmpl=$2 storage=$3
  local net="name=eth0,bridge=${BRIDGE}"
  if [[ $IP == "dhcp" ]]; then
    net+=",ip=dhcp"
  else
    net+=",ip=${IP}"
    [[ -n $GATEWAY ]] && net+=",gw=${GATEWAY}"
  fi

  # RC: the comma in --features is part of the Proxmox value, not an array separator
  # shellcheck disable=SC2054
  local args=(create "$id" "$tmpl"
    --hostname "$CT_HOSTNAME"
    --cores "$CORES" --memory "$RAM" --swap "$RAM"
    --rootfs "${storage}:${DISK}"
    --net0 "$net"
    --unprivileged 1
    --features nesting=1,keyctl=1
    --onboot 1
    --start 1
    --description "Origami setup appliance for Home Assistant")

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  pct %s\n' "${args[*]}"
    return
  fi

  msg "Running: pct create $id …"
  local out
  if ! out=$(pct "${args[@]}" 2>&1); then
    [[ -n $out ]] && printf '%s\n' "$out" >&2
    die "pct create failed (see the message above). Nothing was created."
  fi
  [[ -n $out ]] && printf '%s\n' "$out"

  if ! pct config "$id" >/dev/null 2>&1; then
    die "pct create reported success, but container $id does not exist. Check the Proxmox task log."
  fi
  msg "Container $CTID created."
}

wait_for_ct() {
  local id=$1
  msg "Waiting for container networking …"
  for _ in $(seq 1 60); do
    if pct exec "$id" -- getent hosts github.com >/dev/null 2>&1; then
      pct exec "$id" -- bash -c 'command -v curl >/dev/null 2>&1 || (apt-get update -qq -o Acquire::Retries=3 && apt-get install -y -qq -o Acquire::Retries=3 curl ca-certificates tar gzip xz-utils >/dev/null)'
      return 0
    fi
    sleep 2
  done
  die "Container $id has no DNS/network after 120 s."
}

ct_ip() {
  local id=$1
  pct exec "$id" -- bash -c "ip -4 -o addr show dev eth0 2>/dev/null | awk '{print \$4}' | cut -d/ -f1" | sed -n '1p' || true
}

prepare_payload() {
  local script_dir root_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  root_dir=$(cd "$script_dir/.." && pwd)

  PAYLOAD=$(mktemp /tmp/origami-app.XXXXXX.tgz)
  if [[ -d $root_dir/app/server && -f $root_dir/app/package.json ]]; then
    msg "Using the local checkout at $root_dir"
    tar czf "$PAYLOAD" -C "$root_dir/app" --exclude=node_modules --exclude=data --exclude=test .
  else
    msg "Downloading $REPO@$REF …"
    local tmp
    tmp=$(mktemp -d /tmp/origami-src.XXXXXX)
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" -o "$tmp/src.tgz" \
      || curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${REF}" -o "$tmp/src.tgz" \
      || die "Could not download ${REPO}@${REF}. Set ORIGAMI_LXC_REPO/REF."
    tar xzf "$tmp/src.tgz" -C "$tmp"
    local appdir
    appdir=$(find "$tmp" -maxdepth 2 -type d -name app | sed -n '1p')
    [[ -n $appdir ]] || die "Repository has no app/ directory."
    tar czf "$PAYLOAD" -C "$appdir" --exclude=node_modules --exclude=data --exclude=test .
    rm -rf "$tmp"
  fi
}

prepare_node_tarball() {
  NODE_TARBALL=""
  local node_arch file sums want got
  case $(uname -m) in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) warn "Unknown host architecture; the container will download Node.js itself."; return 0 ;;
  esac

  msg "Preparing Node.js ${NODE_MAJOR} on the host …"
  if ! sums=$(curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
      "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"); then
    warn "Cannot reach nodejs.org from the host; the container will try itself."
    return 0
  fi

  file=$(printf '%s\n' "$sums" | awk -v a="linux-${node_arch}.tar.xz" '$2 ~ a"$" {print $2; exit}' || true)
  if [[ -z $file ]]; then
    warn "No Node.js tarball for linux-${node_arch}; the container will try itself."
    return 0
  fi

  NODE_TARBALL=$(mktemp /tmp/origami-node.XXXXXX.tar.xz)
  if ! curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15 \
      "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}" -o "$NODE_TARBALL"; then
    warn "Node.js download failed on the host; the container will try itself."
    rm -f "$NODE_TARBALL"; NODE_TARBALL=""
    return 0
  fi

  want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1; exit}')
  got=$(sha256sum "$NODE_TARBALL" | awk '{print $1}')
  if [[ -z $want || $want != "$got" ]]; then
    warn "Node.js checksum mismatch on the host; the container will try itself."
    rm -f "$NODE_TARBALL"; NODE_TARBALL=""
    return 0
  fi
}

install_inside() {
  local id=$1 setup_code=$2 root_dir node_arg=""
  root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  pct push "$id" "$PAYLOAD" /root/origami-app.tgz
  pct push "$id" "$root_dir/scripts/install-inside.sh" /root/install-inside.sh
  pct push "$id" "$root_dir/config/origami.service" /root/origami.service
  if [[ -n ${NODE_TARBALL:-} && -f $NODE_TARBALL ]]; then
    pct push "$id" "$NODE_TARBALL" /root/node.tar.xz
    node_arg=/root/node.tar.xz
  fi
  pct exec "$id" -- bash /root/install-inside.sh "$PORT" "$setup_code" "$NODE_MAJOR" "$node_arg"
}

health_check() {
  local id=$1 url=$2
  msg "Checking the web UI …"
  for _ in $(seq 1 45); do
    if pct exec "$id" -- bash -c "curl -fsS --max-time 3 '${url}/api/health' >/dev/null 2>&1"; then
      return 0
    fi
    sleep 2
  done
  pct exec "$id" -- journalctl -u origami --no-pager -n 30 || true
  die "The service did not answer. See: pct exec $id -- journalctl -u origami -e"
}

doctor() {
  msg "Proxmox host"
  local bin
  for bin in pct pveam pvesm; do
    printf '  %-8s %s\n' "$bin" "$(command -v "$bin" 2>/dev/null || echo MISSING)"
  done
  printf '  %-8s %s\n' "version" "$(pveversion 2>/dev/null || echo unknown)"

  msg "Storage (pvesm status)"
  pvesm status 2>&1 | sed 's/^/  /' || true

  local rootdir vztmpl
  rootdir=$(pvesm status --content rootdir 2>/dev/null | awk 'NR > 1 {print $1}' | paste -sd, - || true)
  vztmpl=$(pvesm status --content vztmpl 2>/dev/null | awk 'NR > 1 {print $1}' | paste -sd, - || true)
  printf '  rootdir storages : %s\n' "${rootdir:-none}"
  printf '  vztmpl storages  : %s\n' "${vztmpl:-none}"
  printf '  chosen rootfs    : %s\n' "$(pick_storage)"
  printf '  chosen templates : %s\n' "$(pick_template_storage)"

  msg "LXC templates"
  pveam list "$(pick_template_storage)" 2>&1 | sed 's/^/  /' || true

  msg "Network"
  ip -o link show type bridge 2>/dev/null | awk -F': ' '{print "  " $2}' | cut -d@ -f1 || true
  printf '  chosen bridge    : %s\n' "$([[ $BRIDGE_SET -eq 1 ]] && printf '%s' "$BRIDGE" || pick_bridge)"

  msg "Next container id: $(next_id)"
  [[ -n $HA_CONFIG ]] && printf '  HA config path   : %s\n' "$HA_CONFIG"

  msg "Ready. Re-run without --check to install."
}

# ---------------------------------------------------------------- arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --id) CTID=${2:?}; shift 2 ;;
    --hostname) CT_HOSTNAME=${2:?}; shift 2 ;;
    --ip) IP=${2:?}; shift 2 ;;
    --gw) GATEWAY=${2:?}; shift 2 ;;
    --bridge) BRIDGE=${2:?}; BRIDGE_SET=1; shift 2 ;;
    --cores) CORES=${2:?}; shift 2 ;;
    --ram) RAM=${2:?}; shift 2 ;;
    --disk) DISK=${2:?}; shift 2 ;;
    --storage) STORAGE=${2:?}; shift 2 ;;
    --template-storage) TEMPLATE_STORAGE=${2:?}; shift 2 ;;
    --ha-config) HA_CONFIG=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --check) CHECK=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- main
need_root
check_host

if [[ $CHECK -eq 1 ]]; then
  doctor
  exit 0
fi

[[ $BRIDGE_SET -eq 1 ]] || BRIDGE=$(pick_bridge)

[[ -z $CTID ]] && CTID=$(next_id)
[[ $CTID =~ ^[0-9]+$ ]] || die "--id must be a number."
[[ $DISK -ge 4 ]] || die "--disk must be at least 4 GB."
[[ $RAM -ge 1024 ]] || die "--ram must be at least 1024 MB."

if id_in_use "$CTID"; then
  die "ID $CTID is already used by a VM or container. Pick another --id (e.g. --id 101)."
fi

if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
  die "Bridge '$BRIDGE' does not exist. Available: $(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | paste -sd' ' - || echo none). Use --bridge <name>."
fi

if [[ -n $HA_CONFIG && ! -d $HA_CONFIG ]]; then
  die "HA config path '$HA_CONFIG' does not exist on this host."
fi

if [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 ]]; then
  cat <<EOF

  ${C_B}Origami-LXC${C_0}
  ---------------------------------------------------------
  Container    ${CTID} (${CT_HOSTNAME})
  Resources    ${CORES} vCPU, ${RAM} MB RAM, ${DISK} GB disk
  Network      ${BRIDGE} / ${IP}${GATEWAY:+ via $GATEWAY}
  Web port     ${PORT}
  HA config    ${HA_CONFIG:-not mounted (Samba/SSH or manual mode)}
  ---------------------------------------------------------
EOF
  read -r -p "  Continue? [y/N] " answer
  [[ ${answer:-n} =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

STORAGE=$(pick_storage)
TEMPLATE_STORAGE=$(pick_template_storage)
[[ -n $STORAGE ]] || die "Kein Storage für Container-Disks gefunden. Nutze --storage <name>."
[[ -n $TEMPLATE_STORAGE ]] || die "Kein Storage für LXC-Templates gefunden. Nutze --template-storage <name>."
msg "Storage: Container=${STORAGE}, Templates=${TEMPLATE_STORAGE}"
TMPL=$(ensure_template "$TEMPLATE_STORAGE")
[[ -n $TMPL ]] || die "No template found."

SETUP_CODE=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-8 | tr 'a-f' 'A-F')
[[ ${#SETUP_CODE} -eq 8 ]] || die "Konnte keinen Setup-Code erzeugen."

msg "Creating container $CTID …"
create_ct "$CTID" "$TMPL" "$STORAGE"

if [[ $DRY_RUN -eq 1 ]]; then
  msg "Dry run – stopping here. Would install to /opt/origami and serve ${PORT}."
  exit 0
fi

if [[ -n $HA_CONFIG ]]; then
  msg "Mounting $HA_CONFIG as /ha-config (rw) …"
  pct set "$CTID" -mp0 "${HA_CONFIG},mp=/ha-config"
fi

wait_for_ct "$CTID"
prepare_payload
prepare_node_tarball
install_inside "$CTID" "$SETUP_CODE"
CT_IP=$(ct_ip "$CTID")
[[ -n $CT_IP ]] || die "Could not determine the container IP."
health_check "$CTID" "http://${CT_IP}:${PORT}"

rm -f "$PAYLOAD"
[[ -n ${NODE_TARBALL:-} ]] && rm -f "$NODE_TARBALL"

cat <<EOF

${C_G}Done.${C_0}

  Setup wizard   ${C_B}http://${CT_IP}:${PORT}${C_0}
  Setup code     ${C_B}${SETUP_CODE}${C_0}   (also in /opt/origami/setup-code inside the CT)

  Next steps
    1. Open the wizard and enter your Home Assistant URL and a long-lived token
       (Profile → Security → Long-lived access tokens).
    2. For themes, fonts and plugins the container needs write access to
       Home Assistant's /config. If the wizard says "read-only", run on the host:

         bash install/ha-mount.sh --ctid ${CTID} \\
           --smb '//192.168.1.10/config' --user ha --pass 'secret'

       (HAOS: enable the "Samba share" add-on; user/pass are the add-on's.)
    3. After apply, open Home Assistant → Companion App → add this server.
       The dashboard is called "Origami".

  Logs           pct exec ${CTID} -- journalctl -u origami -f
  Uninstall      pct stop ${CTID} && pct destroy ${CTID}
EOF
