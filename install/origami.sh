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
IP="dhcp"
GATEWAY=""
HA_CONFIG=""
PORT=8080
DRY_RUN=0
ASSUME_YES=0
NODE_MAJOR=22

C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'

trap 'printf "%s\n" "${C_R}xx ${C_0}Unerwarteter Fehler (Exit $?) in Zeile $LINENO: $BASH_COMMAND" >&2' ERR

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
  while pct status "$id" >/dev/null 2>&1; do id=$((id + 1)); done
  printf '%s' "$id"
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
  else
    pct "${args[@]}" >/dev/null
  fi
}

wait_for_ct() {
  local id=$1
  msg "Waiting for container networking …"
  for _ in $(seq 1 60); do
    if pct exec "$id" -- getent hosts github.com >/dev/null 2>&1; then
      pct exec "$id" -- bash -c 'command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl ca-certificates tar gzip xz-utils >/dev/null)'
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

install_inside() {
  local id=$1 setup_code=$2 root_dir
  root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  pct push "$id" "$PAYLOAD" /root/origami-app.tgz
  pct push "$id" "$root_dir/scripts/install-inside.sh" /root/install-inside.sh
  pct push "$id" "$root_dir/config/origami.service" /root/origami.service
  pct exec "$id" -- bash /root/install-inside.sh "$PORT" "$setup_code" "$NODE_MAJOR"
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

# ---------------------------------------------------------------- arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --id) CTID=${2:?}; shift 2 ;;
    --hostname) CT_HOSTNAME=${2:?}; shift 2 ;;
    --ip) IP=${2:?}; shift 2 ;;
    --gw) GATEWAY=${2:?}; shift 2 ;;
    --bridge) BRIDGE=${2:?}; shift 2 ;;
    --cores) CORES=${2:?}; shift 2 ;;
    --ram) RAM=${2:?}; shift 2 ;;
    --disk) DISK=${2:?}; shift 2 ;;
    --storage) STORAGE=${2:?}; shift 2 ;;
    --template-storage) TEMPLATE_STORAGE=${2:?}; shift 2 ;;
    --ha-config) HA_CONFIG=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- main
need_root
check_host

[[ -z $CTID ]] && CTID=$(next_id)
[[ $CTID =~ ^[0-9]+$ ]] || die "--id must be a number."
[[ $DISK -ge 4 ]] || die "--disk must be at least 4 GB."
[[ $RAM -ge 1024 ]] || die "--ram must be at least 1024 MB."

if pct status "$CTID" >/dev/null 2>&1; then
  die "Container $CTID already exists. Pick another --id."
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
install_inside "$CTID" "$SETUP_CODE"
CT_IP=$(ct_ip "$CTID")
[[ -n $CT_IP ]] || die "Could not determine the container IP."
health_check "$CTID" "http://${CT_IP}:${PORT}"

rm -f "$PAYLOAD"

cat <<EOF

${C_G}Done.${C_0}

  Setup wizard   ${C_B}http://${CT_IP}:${PORT}${C_0}
  Setup code     ${C_B}${SETUP_CODE}${C_0}   (also in /opt/origami/setup-code inside the CT)

  Next steps
    1. Open the wizard and enter your Home Assistant URL and a long-lived token
       (Profile → Security → Long-lived access tokens).
    2. For themes, fonts and plugins the container needs write access to
       Home Assistant's /config. If the wizard says "read-only", run on the host:

         bash install/ha-mount.sh --ctid ${CTID} \
           --smb '//192.168.1.10/config' --user ha --pass 'secret'

       (HAOS: enable the "Samba share" add-on; user/pass are the add-on's.)
    3. After apply, open Home Assistant → Companion App → add this server.
       The dashboard is called "Origami".

  Logs           pct exec ${CTID} -- journalctl -u origami -f
  Uninstall      pct stop ${CTID} && pct destroy ${CTID}
EOF
