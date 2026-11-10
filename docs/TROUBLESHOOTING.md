# Fehlersuche

## Der Assistent sagt „kein Schreibzugriff“

Der Container sieht Home Assistants `/config` nicht. Prüfe im Container:

```bash
pct exec 120 -- ls -la /ha-config
pct exec 120 -- cat /ha-config/configuration.yaml | head -5
```

Fehlt der Ordner oder ist er leer:

```bash
# HAOS: Samba share Add-on aktiv, Share erreichbar
bash install/ha-mount.sh --ctid 120 \
  --smb '//192.168.1.10/config' --user homeassistant --pass 'dein-passwort'

# Home Assistant in einem LXC
bash install/ha-mount.sh --ctid 120 --ha-ctid 105
```

Danach im Assistenten **Zugriff prüfen**.

Häufige Ursachen:

- Samba-Add-on aus, falscher Share-Name oder falsches Passwort
- HA-IP falsch oder Port 445 blockiert
- Der Mount existiert, ist aber nach einem Host-Reboot weg → `mount -a` bzw. `/etc/fstab` prüfen
- Der Ordner ist beschreibbar, enthält aber keine `configuration.yaml` → falscher Pfad

## 401 vom Token

Home Assistant hat den Token abgelehnt. Neuen Long-Lived Token erzeugen (Profil → Sicherheit) und im Assistenten neu verbinden. Der Token braucht Admin-Rechte, weil Ressourcen, Helfer und Dashboards angelegt werden.

## Plugins lassen sich nicht laden

Der Container braucht Internetzugriff auf `cdn.jsdelivr.net`, `raw.githubusercontent.com`, `github.com` und `codeload.github.com`. Prüfe:

```bash
pct exec 120 -- curl -I https://cdn.jsdelivr.net
pct exec 120 -- curl -I https://codeload.github.com
```

Schlägt ein Plugin fehl, steht das im Apply-Log als Warnung; der Rest wird trotzdem installiert. Der Download landet in `/opt/origami/data/cache` und wird beim nächsten Versuch wiederverwendet.

## Dashboard fehlt oder ist leer

- Nach dem Apply in Home Assistant: Einstellungen → Dashboards. Dort muss **Origami** mit Pfad `origami` stehen.
- Zeigt das Dashboard „Custom element doesn't exist: bubble-card“, fehlen die Ressourcen oder der Browser-Cache ist alt. Einstellungen → Dashboards → Ressourcen prüfen und die Seite neu laden (harter Reload).
- Nach der Installation von **Bubble Card Tools** ist ein Home-Assistant-Neustart nötig. Der Assistent bietet ihn an.

## Theme wird nicht angezeigt

- Profil → Theme **Origami** auswählen.
- `configuration.yaml` muss `frontend: themes: !include_dir_merge_named themes` enthalten. Der Assistent patcht das nur, wenn kein Inline-`frontend:`-Wert existiert; andernfalls steht eine Warnung im Plan.
- Nach dem Patch Home Assistant neu starten bzw. Themes neu laden.

## Der Container wird nicht erstellt

Zuerst die Umgebung prüfen – das ändert nichts:

```bash
bash install/origami.sh --check
```

Die Ausgabe zeigt `pct`/`pveam`/`pvesm`, alle Storages mit Inhaltstyp, das gewählte Rootfs, die Template-Storage, vorhandene Bridges und die nächste freie ID. Damit lässt sich fast jeder Abbruch vor `pct create` zuordnen.

**„ID … is already used by a VM or container“**
Proxmox vergibt VMIDs an VMs und Container gemeinsam. `pct status 100` meldet „does not exist“, wenn 100 eine **VM** ist (z. B. die HAOS-VM). Der Installer erkennt das jetzt und nimmt automatisch die nächste freie ID; alternativ `--id 120` angeben.

**„Bridge … does not exist“**
Ohne `--bridge` wählt der Installer `vmbr0`, falls vorhanden, sonst die erste gefundene Bridge. Heißt deine Bridge anders:

```bash
bash install/origami.sh --bridge vmbr1
```

**„pct create failed“**
Die Meldung von Proxmox steht direkt darüber. Häufig: Storage voll, `local-lvm` ohne freien Platz, oder das Template passt nicht zum Storage. Prüfe danach:

```bash
pct create ...        # exakt die Zeile aus der Fehlermeldung erneut ausführen
pvesm status
```

**Gar keine Ausgabe nach der Bestätigung?**
Dann fehlt die Bestätigung (`y` + Enter) oder die Ausgabe wurde nicht mitgeschnitten. Immer vollständig ausführen und die letzten Zeilen kopieren:

```bash
bash install/origami.sh 2>&1 | tee /tmp/origami-install.log
```

## Dienst startet nicht

```bash
pct exec 120 -- systemctl status origami --no-pager
pct exec 120 -- journalctl -u origami -n 80 --no-pager
```

Typische Ursachen: Port belegt, Node-Installation unvollständig, fehlende Schreibrechte auf `/opt/origami/data`. Ein erneutes `bash scripts/install-inside.sh 8080 <code> 22` im Container installiert die App erneut.

## Oberfläche nicht erreichbar

- `pct exec 120 -- ip -4 addr show eth0` – hat der Container eine IP?
- Firewall auf dem Proxmox-Host: Port 8080 freigeben.
- Der Dienst lauscht standardmäßig auf `0.0.0.0:8080`.

## Setup-Code vergessen

```bash
pct exec 120 -- cat /opt/origami/setup-code
```

Ist die Datei leer oder fehlt, beim Neustart des Dienstes wird ein neuer Code erzeugt und im Journal ausgegeben:

```bash
pct exec 120 -- journalctl -u origami -n 20 --no-pager | grep Setup
```

## Installation zurücksetzen

Im Assistenten **Rollback** wählen. Das entfernt Dashboard, Ressourcen und Helfer und stellt die gesicherten Dateien wieder her. Dateien, die es vorher schon gab, werden aus dem Backup überschrieben; ein vollständiges HA-Backup ersetzt das nicht.

Komplett neu:

```bash
pct stop 120 && pct destroy 120
rm -rf /srv/origami
# /etc/fstab-Eintrag für den HA-Mount entfernen, falls nicht mehr gebraucht
```

## Logs und Zustand

```bash
pct exec 120 -- journalctl -u origami -f
pct exec 120 -- ls -la /opt/origami/data
pct exec 120 -- cat /opt/origami/data/state.json   # Token ist verschlüsselt
```

Der Verlauf der letzten Aktionen steht in der Oberfläche unter „Verlauf“.
