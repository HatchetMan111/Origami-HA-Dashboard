#!/usr/bin/env bash
# Gives the Origami container write access to Home Assistant's /config.
#
#   HAOS VM, interactive (finds the HA IP, asks for user/password):
#     bash install/ha-mount.sh --ctid 120
#
#   HAOS VM, non-interactive:
#     bash install/ha-mount.sh --ctid 120 --smb '//10.0.0.5/config' \
#       --user homeassistant --pass 'secret'
#
#   HA in an LXC (bind mount already on the host):
#     bash install/ha-mount.sh --ctid 120 --path /tank/ha/config
#
#   HA in an LXC, auto-detect its config mount point:
#     bash install/ha-mount.sh --ctid 120 --ha-ctid 105
set -euo pipefail

CTID="" SMB="" USER="" PASS="" PATH_SRC="" HA_CTID="" HA_IP="" SHARE="config"
CRED_FILE=""
MOUNT_VERS="3.0"
C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
msg() { printf '%s\n' "${C_G}==>${C_0} $*"; }
warn() { printf '%s\n' "${C_Y}!! ${C_0}$*"; }
die() { printf '%s\n' "${C_R}xx ${C_0}$*" >&2; exit 1; }

cleanup() { [[ -n $CRED_FILE ]] && rm -f "$CRED_FILE"; return 0; }
trap cleanup EXIT

usage() {
  cat <<EOF
Aufruf: ha-mount.sh --ctid <origami-ct> [Optionen]

  --ctid <id>          ID des Origami-Containers (Pflicht)
  --smb <//host/share> Samba-Freigabe, z. B. '//10.0.0.5/config'
  --ha-ip <addr>       HA-IP; baut --smb '//<ip>/config'
  --share <name>       Share-Name (Standard: config)
  --user <name>        Samba-Benutzer des Add-ons (Standard: homeassistant)
  --pass <password>    Samba-Passwort (sonst interaktive Abfrage)
  --path <dir>         HA-Config, die auf dem Host schon liegt (LXC)
  --ha-ctid <id>       HA-Container; Mountpunkt wird automatisch erkannt
  --mountpoint <dir>   Mountpunkt auf dem Host (Standard: /srv/origami/ha-config)

Ohne --smb/--path/--ha-ctid fragt das Skript IP, Benutzer und Passwort ab.
EOF
}

detect_ha_ip() {
  local vmid name ip
  command -v qm >/dev/null 2>&1 || return 0
  while read -r vmid name; do
    name=${name,,}
    [[ $name =~ (haos|home[_-]?assistant|hass) ]] || continue
    ip=$(qm guest cmd "$vmid" network-get-interfaces 2>/dev/null \
      | awk -F'"' '/^[[:space:]]*"ip-address"[[:space:]]*:/ {print $4}' \
      | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' \
      | grep -vE '^(127\.|169\.254\.|0\.)' | head -n1 || true)
    if [[ -n $ip ]]; then printf '%s' "$ip"; return; fi
  done < <(qm list 2>/dev/null | awk 'NR > 1 {print $1, $2}')
}

ask() {
  local prompt=$1 default=$2 answer
  if [[ -n $default ]]; then
    read -r -p "  $prompt [$default]: " answer
    printf '%s' "${answer:-$default}"
  else
    read -r -p "  $prompt: " answer
    printf '%s' "$answer"
  fi
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --ctid) CTID=${2:?}; shift 2 ;;
    --smb) SMB=${2:?}; shift 2 ;;
    --ha-ip) HA_IP=${2:?}; shift 2 ;;
    --share) SHARE=${2:?}; shift 2 ;;
    --user) USER=${2:?}; shift 2 ;;
    --pass) PASS=${2:?}; shift 2 ;;
    --path) PATH_SRC=${2:?}; shift 2 ;;
    --ha-ctid) HA_CTID=${2:?}; shift 2 ;;
    --mountpoint) MOUNTPOINT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unbekannte Option: $1 (siehe --help)" ;;
  esac
done

[[ ${EUID:-0} -eq 0 ]] || die "Bitte als root auf dem Proxmox-Host ausführen."
[[ -n $CTID ]] || die "--ctid ist erforderlich."
pct status "$CTID" >/dev/null 2>&1 || die "Container $CTID existiert nicht."
MOUNTPOINT="${MOUNTPOINT:-/srv/origami/ha-config}"

# ---------------------------------------------------------------- interactive
if [[ -z $SMB && -z $PATH_SRC && -z $HA_CTID && -n ${HA_IP:-} ]]; then
  SMB="//${HA_IP}/${SHARE}"
fi

if [[ -z $SMB && -z $PATH_SRC && -z $HA_CTID ]]; then
  [[ -t 0 ]] || { usage; exit 1; }
  printf '\n  Home Assistant einbinden\n  ---------------------------------------------------------\n'
  detected=$(detect_ha_ip)
  [[ -n $detected ]] && msg "HA-IP automatisch erkannt: $detected"
  HA_IP=$(ask "IP der Home-Assistant-VM" "$detected")
  [[ -n $HA_IP ]] || die "Ohne HA-IP geht es nicht. Starte das Samba-Add-on und versuche es erneut."
  SHARE=$(ask "Samba-Share" "$SHARE")
  USER=$(ask "Samba-Benutzer (aus dem Add-on)" "${USER:-homeassistant}")
  read -rsp "  Samba-Passwort: " PASS; echo
  [[ -n $PASS ]] || die "Das Samba-Passwort fehlt."
  SMB="//${HA_IP}/${SHARE}"
  printf '  ---------------------------------------------------------\n\n'
fi

if [[ -n $HA_CTID ]]; then
  line=$(pct config "$HA_CTID" | awk '/^mp[0-9]+: / && /\/config/ {print; exit}')
  [[ -z $line ]] && line=$(pct config "$HA_CTID" | awk '/^mp[0-9]+: / {print; exit}')
  [[ -n $line ]] || die "In Container $HA_CTID wurde kein Mountpunkt gefunden."
  PATH_SRC=$(printf '%s' "$line" | sed -E 's/^mp[0-9]+: ([^,]+).*/\1/')
  msg "HA-Config auf dem Host erkannt: $PATH_SRC"
fi

# ---------------------------------------------------------------- mount
if [[ -n $SMB ]]; then
  if ! command -v mount.cifs >/dev/null 2>&1; then
    msg "Installiere cifs-utils …"
    apt-get update -qq -o Acquire::Retries=3
    apt-get install -y -qq -o Acquire::Retries=3 cifs-utils >/dev/null
  fi

  if [[ -z $USER ]]; then
    [[ -t 0 ]] || die "--user ist mit --smb erforderlich."
    USER=$(ask "Samba-Benutzer (aus dem Add-on)" "homeassistant")
  fi
  if [[ -z $PASS ]]; then
    [[ -t 0 ]] || die "--pass ist mit --smb erforderlich (oder interaktiv ausführen)."
    read -rsp "  Samba-Passwort: " PASS; echo
  fi

  host=${SMB#//}; host=${host%%/*}
  msg "Prüfe, ob $host:445 erreichbar ist …"
  if ! timeout 3 bash -c "echo >/dev/tcp/${host}/445" 2>/dev/null; then
    warn "Port 445 auf $host antwortet nicht."
    warn "Läuft das Samba-Add-on? Ist $host wirklich die HAOS-VM und nicht der Proxmox-Host?"
    warn "Die IP steht auch im Add-on-Log: 'Samba name server ... on subnet <IP>'."
  fi

  mkdir -p "$MOUNTPOINT"
  if mountpoint -q "$MOUNTPOINT"; then
    msg "Bereits gemountet: $MOUNTPOINT"
  else
    CRED_FILE=$(mktemp)
    printf 'username=%s\npassword=%s\n' "$USER" "$PASS" > "$CRED_FILE"
    chmod 600 "$CRED_FILE"

    msg "Mounte $SMB …"
    ok=0; err=""
    for vers in 3.1.1 3.0 2.1; do
      if err=$(mount -t cifs "$SMB" "$MOUNTPOINT" \
          -o "credentials=$CRED_FILE,uid=0,gid=0,rw,vers=$vers,iocharset=utf8,noperm,dir_mode=0777,file_mode=0666" 2>&1); then
        ok=1; MOUNT_VERS=$vers; break
      fi
    done
    rm -f "$CRED_FILE"; CRED_FILE=""

    if [[ $ok -ne 1 ]]; then
      [[ -n $err ]] && printf '%s\n' "$err" >&2
      case $err in
        *"Permission denied"*|*"(13)"*)
          warn "Benutzer/Passwort falsch oder der Host ist im Add-on nicht erlaubt."
          warn "Prüfe im Add-on: Benutzername, Passwort und allow_hosts (muss die Proxmox-IP enthalten)." ;;
        *"(2)"*)
          warn "Die Freigabe '$SHARE' existiert nicht. Prüfe den Share-Namen im Add-on." ;;
        *"(6)"*|*"(112)"*)
          warn "Home Assistant ist nicht erreichbar. Prüfe IP und Netzwerk." ;;
        *"No route to host"*)
          warn "Keine Route zu $host. HA und Proxmox müssen sich erreichen können." ;;
      esac
      die "Samba-Mount fehlgeschlagen."
    fi
    msg "Samba-Mount erfolgreich."
  fi
elif [[ -n $PATH_SRC ]]; then
  [[ -d $PATH_SRC ]] || die "Pfad existiert nicht: $PATH_SRC"
  mkdir -p "$MOUNTPOINT"
  if mountpoint -q "$MOUNTPOINT"; then
    msg "Bereits gemountet: $MOUNTPOINT"
  else
    msg "Binde $PATH_SRC ein …"
    mount --bind "$PATH_SRC" "$MOUNTPOINT"
  fi
  owner=$(stat -c '%u' "$PATH_SRC" 2>/dev/null || echo 0)
  if [[ $owner -ne 100000 ]]; then
    warn "Der Ordner gehört auf dem Host UID $owner. Im unprivilegierten Container ist er nur schreibbar, wenn er UID 100000 gehört oder für alle schreibbar ist."
    warn "Bei einer HAOS-VM stattdessen den Samba-Share (--smb) verwenden."
  fi
else
  usage
  exit 1
fi

probe="$MOUNTPOINT/.origami-write-test-$$"
if ! printf ok > "$probe" 2>/dev/null; then
  die "Der Mount ist da, aber root auf dem Host kann nicht nach $MOUNTPOINT schreiben. Prüfe das Samba-Add-on (Share '$SHARE', Benutzer, gestartet) bzw. die Ordnerrechte."
fi
rm -f "$probe"

# ---------------------------------------------------------------- persistence
FSTAB_LINE=""
if [[ -n $SMB ]]; then
  printf 'username=%s\npassword=%s\n' "$USER" "$PASS" > /etc/origami-cifs.credentials
  chmod 600 /etc/origami-cifs.credentials
  FSTAB_LINE="${SMB} ${MOUNTPOINT} cifs credentials=/etc/origami-cifs.credentials,uid=0,gid=0,rw,vers=${MOUNT_VERS},iocharset=utf8,noperm,dir_mode=0777,file_mode=0666,nofail,_netdev 0 0"
elif [[ -n $PATH_SRC ]]; then
  FSTAB_LINE="${PATH_SRC} ${MOUNTPOINT} none bind 0 0"
fi
if [[ -n $FSTAB_LINE ]]; then
  if [[ -f /etc/fstab ]] && grep -qF "$MOUNTPOINT" /etc/fstab; then
    sed -i "\#${MOUNTPOINT}#d" /etc/fstab
  fi
  printf '%s\n' "$FSTAB_LINE" >> /etc/fstab
fi

# ---------------------------------------------------------------- container
if ! pct config "$CTID" | grep -q "mp.*=$MOUNTPOINT"; then
  idx=0
  while pct config "$CTID" | grep -q "^mp${idx}:"; do idx=$((idx + 1)); done
  msg "Hänge $MOUNTPOINT als mp${idx} in Container $CTID …"
  pct set "$CTID" "-mp${idx}" "${MOUNTPOINT},mp=/ha-config"
  added=1
else
  added=0
  msg "Container $CTID hat /ha-config bereits."
fi

if ! pct status "$CTID" 2>/dev/null | grep -q running; then
  msg "Starte Container $CTID …"
  pct start "$CTID" >/dev/null
elif [[ $added -eq 1 ]]; then
  msg "Starte Container $CTID neu, damit er den Mount sieht …"
  pct reboot "$CTID" >/dev/null
fi

msg "Warte auf den Container …"
for _ in $(seq 1 60); do
  if pct status "$CTID" 2>/dev/null | grep -q running && pct exec "$CTID" -- true >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

msg "Prüfe Schreibzugriff im Container …"
if pct exec "$CTID" -- bash -c 'f=/ha-config/.origami-write-test-$$; if printf ok >"$f" 2>/dev/null; then rm -f "$f"; exit 0; fi; exit 1'; then
  msg "Schreibzugriff auf /ha-config bestätigt."
else
  warn "Der Container kann /ha-config nicht beschreiben."
  warn "Samba-Add-on: Share '$SHARE' muss für diesen Benutzer schreibbar sein, Add-on gestartet."
  warn "Unprivilegiert: bind-gemountete Ordner müssen auf dem Host UID 100000 gehören oder für alle schreibbar sein."
  pct exec "$CTID" -- ls -lan /ha-config 2>/dev/null | sed 's/^/   /' || true
  pct exec "$CTID" -- mount 2>/dev/null | grep ha-config | sed 's/^/   /' || true
  die "Kein Schreibzugriff aus dem Container. Siehe Hinweise oben."
fi

ip=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
echo
msg "Fertig. Im Wizard auf \"Zugriff prüfen\" klicken."
[[ -n $ip ]] && printf '    %shttp://%s:8080%s\n' "$C_B" "$ip" "$C_0"
