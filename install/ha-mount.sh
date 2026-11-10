#!/usr/bin/env bash
# Gives the Origami container write access to Home Assistant's /config.
#
#   HAOS VM: enable the "Samba share" add-on, then:
#     bash install/ha-mount.sh --ctid 120 --smb '//192.168.1.10/config' \
#       --user homeassistant --pass 'secret'
#
#   HA in an LXC (bind mount already on the host):
#     bash install/ha-mount.sh --ctid 120 --path /tank/ha/config
#
#   HA in an LXC, auto-detect its config mount point:
#     bash install/ha-mount.sh --ctid 120 --ha-ctid 105
set -euo pipefail

CTID="" SMB="" USER="" PASS="" PATH_SRC="" HA_CTID=""
C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
msg() { printf '%s\n' "${C_G}==>${C_0} $*"; }
warn() { printf '%s\n' "${C_Y}!! ${C_0}$*"; }
die() { printf '%s\n' "${C_R}xx ${C_0}$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: ha-mount.sh --ctid <origami-ct> (--smb <//host/share> | --path <dir> | --ha-ctid <ct>)
                   [--user <name>] [--pass <password>] [--mountpoint /srv/origami/ha-config]

Mounts Home Assistant's /config on the Proxmox host and bind-mounts it into the
Origami container as /ha-config.
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --ctid) CTID=${2:?}; shift 2 ;;
    --smb) SMB=${2:?}; shift 2 ;;
    --user) USER=${2:?}; shift 2 ;;
    --pass) PASS=${2:?}; shift 2 ;;
    --path) PATH_SRC=${2:?}; shift 2 ;;
    --ha-ctid) HA_CTID=${2:?}; shift 2 ;;
    --mountpoint) MOUNTPOINT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ ${EUID:-0} -eq 0 ]] || die "Run as root on the Proxmox host."
[[ -n $CTID ]] || die "--ctid is required."
pct status "$CTID" >/dev/null 2>&1 || die "Container $CTID does not exist."
MOUNTPOINT="${MOUNTPOINT:-/srv/origami/ha-config}"

if [[ -n $HA_CTID ]]; then
  line=$(pct config "$HA_CTID" | awk '/^mp[0-9]+: / && /\/config/ {print; exit}')
  [[ -z $line ]] && line=$(pct config "$HA_CTID" | awk '/^mp[0-9]+: / {print; exit}')
  [[ -n $line ]] || die "No mount point found in container $HA_CTID."
  PATH_SRC=$(printf '%s' "$line" | sed -E 's/^mp[0-9]+: ([^,]+).*/\1/')
  msg "Detected HA config on the host: $PATH_SRC"
fi

if [[ -n $SMB ]]; then
  command -v mount.cifs >/dev/null 2>&1 || {
    msg "Installing cifs-utils …"
    apt-get update -qq && apt-get install -y -qq cifs-utils >/dev/null
  }
  [[ -n $USER ]] || die "--user is required with --smb."
  mkdir -p "$MOUNTPOINT"
  if mountpoint -q "$MOUNTPOINT"; then
    msg "Already mounted: $MOUNTPOINT"
  else
    cred=$(mktemp)
    printf 'username=%s\npassword=%s\n' "$USER" "${PASS:-}" > "$cred"
    chmod 600 "$cred"
    msg "Mounting $SMB …"
    mount -t cifs "$SMB" "$MOUNTPOINT" -o "credentials=$cred,uid=0,gid=0,vers=3.0,iocharset=utf8,noperm,dir_mode=0777,file_mode=0666"
    rm -f "$cred"
  fi
elif [[ -n $PATH_SRC ]]; then
  [[ -d $PATH_SRC ]] || die "Path does not exist: $PATH_SRC"
  mkdir -p "$MOUNTPOINT"
  if mountpoint -q "$MOUNTPOINT"; then msg "Already mounted: $MOUNTPOINT"; else
    msg "Bind-mounting $PATH_SRC …"
    mount --bind "$PATH_SRC" "$MOUNTPOINT"
  fi
  owner=$(stat -c '%u' "$PATH_SRC" 2>/dev/null || echo 0)
  if [[ $owner -ne 100000 ]]; then
    warn "Der Ordner gehört auf dem Host UID $owner. Im unprivilegierten Container ist er nur schreibbar, wenn er UID 100000 gehört oder für alle schreibbar ist."
    warn "Bei einer privilegierten HA-Installation besser den Samba-Share (--smb) verwenden."
  fi
else
  usage
  exit 1
fi

# Persist across host reboots
FSTAB_LINE=""
if [[ -n $SMB ]]; then
  FSTAB_LINE="${SMB} ${MOUNTPOINT} cifs credentials=/etc/origami-cifs.credentials,uid=0,gid=0,vers=3.0,iocharset=utf8,noperm,dir_mode=0777,file_mode=0666 0 0"
  printf 'username=%s\npassword=%s\n' "$USER" "${PASS:-}" > /etc/origami-cifs.credentials
  chmod 600 /etc/origami-cifs.credentials
elif [[ -n $PATH_SRC ]]; then
  FSTAB_LINE="${PATH_SRC} ${MOUNTPOINT} none bind 0 0"
fi
if [[ -n $FSTAB_LINE ]] && ! grep -qF "$MOUNTPOINT" /etc/fstab; then
  printf '%s\n' "$FSTAB_LINE" >> /etc/fstab
fi

if ! pct config "$CTID" | grep -q "mp.*=$MOUNTPOINT"; then
  idx=0
  while pct config "$CTID" | grep -q "^mp${idx}:"; do idx=$((idx + 1)); done
  msg "Attaching $MOUNTPOINT to container $CTID as mp${idx} …"
  pct set "$CTID" "-mp${idx}" "${MOUNTPOINT},mp=/ha-config"
else
  msg "Container $CTID already has /ha-config."
fi

msg "Done. Open the wizard and press \"Zugriff prüfen\"."
