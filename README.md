# Origami-LXC

[![CI](https://github.com/HatchetMan111/Origami-HA-Dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/HatchetMan111/Origami-HA-Dashboard/actions/workflows/ci.yml)
[![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-blue.svg)](LICENSE)

Ein Einrichtungsassistent als Proxmox-LXC, der das [Origami-Dashboard](https://github.com/hazymorning/origami) in eine **bestehende** Home-Assistant-Installation einbaut: Theme, Fonts, Bubble-Card-Module, Plugins, Helfer und die Dashboard-Ansichten. Danach öffnest du die Home-Assistant-Companion-App und hast ein aufgeräumtes, app-artiges Dashboard auf dem Handy – ohne YAML-Dateien von Hand zu bearbeiten.

Die Appliance ist **kein Fork** von Home Assistant und ersetzt keine Installation. Sie verbindet sich über die Home-Assistant-REST- und WebSocket-API, legt Dateien in `/config` ab und schreibt das Dashboard über die offizielle Lovelace-API. Vorher wird ein Backup angelegt, ein Rollback ist eingebaut.

> **Status: v0.1 (MVP).** Installiert werden der Home-View mit Begrüßung, Wetter, Raumkarten, Klima-Tabelle, Lichter-Pop-up und Navigationsleiste. Raum-Pop-ups, Musik, TV, Saugroboter, Favoriten und die restlichen Origami-Ansichten folgen in v0.2.

---

## Was du am Ende hast

- **Ein fertiges Dashboard** mit Origami-Design, das auf dem Handy wie eine eigene App wirkt.
- **Raumkarten** mit Licht, Temperatur, Luftfeuchte und Fensterkontakt – automatisch aus deinen Home-Assistant-Bereichen vorgeschlagen.
- **Wetterkarte** im Papier-Diorama-Stil, lokal ausgeliefert (keine externen Bild-URLs).
- **Klima-Tabelle** über alle Räume, ein- und ausklappbar.
- **Lichter-Pop-up** mit Slidern für deine Lampen und einem Gruppen-Schalter.
- **Navigationsleiste** unten mit Lichtern und optionalem Menü.
- **Kein YAML-Gefrickel:** Der Assistent zeigt dir vor dem Schreiben, was er tun wird, und prüft das Ergebnis danach.

Zeitbedarf: etwa **10–15 Minuten**, davon sind die meisten Klicks im Assistenten.

---

## Voraussetzungen

| Voraussetzung | Details |
| --- | --- |
| Proxmox VE | Version 8 oder neuer, Root-Zugriff auf den Host |
| Home Assistant | laufend, aktuell genug für die Sections-View (HAOS-VM, HA im LXC oder Container) |
| Token | Long-Lived Access Token mit Admin-Rechten: Profil → Sicherheit → Long-Lived Access Tokens |
| Schreibzugriff auf `/config` | für Theme, Fonts und Plugins – bei HAOS über das „Samba share“-Add-on, bei HA im LXC über den Config-Pfad |
| Netzwerk | Der Container erreicht Home Assistant und GitHub; dein Handy erreicht den Container |

> **Ohne Schreibzugriff auf `/config`** funktionieren nur Verbinden, Zuordnen und Plan. Für die manuelle Installation kannst du dir im Assistenten ein fertiges Bundle herunterladen (siehe [Manueller Modus](#manueller-modus-ohne-schreibzugriff)).

---

## Einrichtung Schritt für Schritt

### 1. Container auf dem Proxmox-Host installieren

Als **root** auf dem Proxmox-Host:

```bash
git clone https://github.com/HatchetMan111/Origami-HA-Dashboard.git
cd Origami-HA-Dashboard
bash install/origami.sh
```

Der Installer erklärt dir vorher, was er anlegt, und fragt einmal nach. Standardwerte:

| Einstellung | Standard |
| --- | --- |
| Container-ID | nächste freie ab 100 |
| Hostname | `origami` |
| Ressourcen | 2 vCPU, 2 GB RAM, 8 GB Disk |
| Netzwerk | `vmbr0`, DHCP |
| Web-Port | `8080` |
| Template | Debian 13 (oder 12), automatisch gewählt |

Am Ende steht dort:

```
Setup wizard   http://192.168.1.50:8080
Setup code     AB12CD34EF56
```

> Für reproduzierbare Installationen nach dem ersten Release den Tag auschecken: `git checkout v0.1.0`. Der Branch `main` ist beweglich; ein Tag ist es nicht.

Der Setup-Code liegt zusätzlich im Container unter `/opt/origami/setup-code`.

**Eigene Werte** (Beispiel mit fester IP):

```bash
bash install/origami.sh --id 120 --ip 192.168.1.50/24 --gw 192.168.1.1
```

**Nur ansehen, nichts ändern:**

```bash
bash install/origami.sh --dry-run
```

**Host prüfen, wenn der Container nicht erstellt wird:**

```bash
bash install/origami.sh --check
```

Das zeigt Storages, Templates, Bridges und die nächste freie ID, ohne etwas zu verändern. Details: [Fehlersuche](#fehlersuche).

Alle Optionen: `bash install/origami.sh --help`.

> `--ha-config /pfad/zu/config` kannst du direkt mitgeben, wenn der Ordner auf dem Host schon **dauerhaft** gemountet ist. Für HAOS ist der Samba-Weg im nächsten Schritt meist einfacher.

### 2. Home Assistants `/config` einbinden

#### HAOS (VM) – über das Samba-Add-on

1. In Home Assistant: **Einstellungen → Add-ons → Add-on-Store → Samba share** installieren.
2. Im Add-on unter **Konfiguration**:
   - `username` und `password` setzen – das sind **eigene Zugangsdaten für die Freigabe**, nicht dein HA-Login.
   - `allow_hosts` muss die IP des Proxmox-Hosts enthalten. Der Standard (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`) passt für die meisten Netze.
3. Add-on **starten**. Im Log steht die entscheidende Zeile:

   ```
   Samba name server HOMEASSISTANT is now a local master browser ... on subnet 10.120.1.175
   ```

   Die IP dahinter (`10.120.1.175`) ist die Adresse deiner HAOS-VM. **Diese** IP gehört in den Mount – nicht die des Proxmox-Hosts. HAOS kann in einem anderen Subnetz als dein LAN liegen; Proxmox muss es erreichen können.

4. Auf dem Proxmox-Host, interaktiv (empfohlen):

```bash
bash install/ha-mount.sh --ctid <CTID>
```

Das Skript sucht die HA-VM automatisch (QEMU-Guest-Agent), fragt IP, Share, Benutzer und Passwort ab und prüft am Ende den Schreibzugriff **im Container**.

Oder alles in einer Zeile:

```bash
bash install/ha-mount.sh --ctid <CTID> \
  --smb '//10.120.1.175/config' --user homeassistant --pass '<passwort>'
```

Erwartete Ausgabe:

```
==> HA-IP automatisch erkannt: 10.120.1.175
==> Mounte //10.120.1.175/config …
==> Samba-Mount erfolgreich.
==> Hänge /srv/origami/ha-config als mp0 in Container 112 …
==> Starte Container 112 neu, damit er den Mount sieht …
==> Schreibzugriff auf /ha-config bestätigt.
```

Das Skript mountet dauerhaft (inkl. `/etc/fstab`, `nofail`), hängt den Ordner als `/ha-config` in den Container und startet ihn bei Bedarf neu.

**Wenn der Mount scheitert**, sagt das Skript jetzt, was zu tun ist:

| Meldung | Ursache |
| --- | --- |
| `mount error(13): Permission denied` | Benutzer/Passwort falsch oder Proxmox-IP fehlt in `allow_hosts` |
| `mount error(2)` | Share-Name falsch (Standard: `config`) |
| `mount error(6)` / `No route to host` | Falsche HA-IP oder HA/Proxmox erreichen sich nicht |
| Port 445 antwortet nicht | Samba-Add-on nicht gestartet oder falsche IP |

#### Home Assistant in einem LXC

```bash
# Pfad direkt angeben
bash install/ha-mount.sh --ctid <CTID> --path /pfad/zu/ha/config

# oder den Mount-Punkt des HA-Containers automatisch erkennen
bash install/ha-mount.sh --ctid <CTID> --ha-ctid <HA-CTID>
```

> Der Ordner muss im unprivilegierten Container für UID `100000` schreibbar sein. Das Skript warnt, wenn die Besitzrechte nicht passen. Bei einer privilegierten HA-Installation ist der Samba-Weg oft die einfachere Lösung.

#### Zugriff prüfen

Im Assistenten auf **Zugriff prüfen** klicken. Dort muss „Schreibzugriff auf `/config`“ stehen. Alternativ im Container:

```bash
pct exec <CTID> -- bash -c 'touch /ha-config/.probe && rm /ha-config/.probe && echo "schreibbar"'
```

### 3. Assistenten öffnen und ausfüllen

`http://<container-ip>:8080` im Browser öffnen und den Setup-Code eingeben.

1. **Verbinden**
   - HA-URL eintragen, z. B. `http://192.168.1.10:8123`
   - Long-Lived Access Token einfügen
   - Der Assistent prüft Verbindung, Version und Registries.

2. **Zuordnen**
   - Räume werden aus deinen Home-Assistant-Bereichen (Areas) vorgeschlagen.
   - Pro Raum: Licht, Temperatur, Luftfeuchte, Fenster, Klima, Mediaplayer.
   - Global: Wetter, Kalender, Lichtgruppe, TV, Lautsprecher.
   - Alles ist änderbar; leere Felder werden einfach weggelassen.

3. **Installieren**
   - Optionen wählen (Begrüßung, Wetter, Räume, Klima-Tabelle, Alle Räume, Menü, Lichter-Pop-up, Navigationsleiste).
   - **Plan ansehen**: zeigt Karten, Helfer, Plugins, Dateien und fehlende Entitäten.
   - **Installieren** startet den Job mit Live-Log.
   - Danach: **Home Assistant neu starten** (wegen der Bubble-Card-Tools-Integration).

4. **Prüfen**
   - Der Assistent prüft Dateien, Dashboard und Ressourcen.
   - Bei Problemen: **Nur prüfen**, **Rollback** oder Logs ansehen.

### 4. Auf dem Handy einrichten

1. Home-Assistant-Companion-App öffnen und den Server hinzufügen.
2. **Profil → Theme → Origami** auswählen.
3. Dashboard **Origami** öffnen (Sidebar oder als Start-Dashboard in der Companion-App).
4. Optional: In der Companion-App das Origami-Dashboard als Startseite festlegen.

> Das Theme wird pro Home-Assistant-Benutzer gewählt. Auf einem zweiten Handy also dort ebenfalls einmal `Origami` auswählen.

---

## Was genau installiert wird

| Ort | Inhalt |
| --- | --- |
| `themes/origami.yaml` | Origami-Theme |
| `www/fonts/` | Montserrat-Fonts und Stylesheet |
| `bubble_card/modules/` | Origami-Bubble-Card-Module |
| `www/origami/weather/` | Wetterbilder (Diorama und House) |
| `www/community/<plugin>/` | Bubble Card, Origami Header, Notifications, Weather, Navbar Card |
| `custom_components/bubble_card_tools/` | Bubble Card Tools (Integration, Neustart nötig) |
| `configuration.yaml` | ergänzt `frontend.themes` und ggf. `frontend.extra_module_url` |
| Lovelace-Ressourcen | Stylesheet + Plugin-Module |
| Dashboard `Origami` | Pfad `/origami-dashboard`, als Storage-Dashboard gespeichert |
| Helfer | `input_boolean.all_rooms`, `input_boolean.climate_table` |

Origami selbst wird **nicht mitgeliefert**. Der Container lädt beim Installieren den gepinnten Stand `V3.0` von GitHub. So bleibt die Lizenz sauber und du bekommst genau die Vorlagen, aus denen das Dashboard gebaut wird.

Der Patch an `configuration.yaml` ist bewusst vorsichtig: Er ergänzt nur einen `frontend:`-Block bzw. fehlende Schlüssel. Steht dort bereits ein Inline-Wert (z. B. `frontend: !include frontend.yaml`), wird nichts geändert und der Assistent zeigt eine Warnung.

---

## Nach der Installation

- **Nachträglich prüfen:** Im Assistenten **Nur prüfen**.
- **Zurücksetzen:** **Rollback** entfernt Dashboard, Ressourcen und Helfer und stellt die gesicherten Dateien wieder her.
- **Erneut installieren:** Der Assistent aktualisiert das bestehende Dashboard und legt vorhandene Ressourcen nicht doppelt an.
- **Verlauf:** Die letzten Aktionen stehen in der Oberfläche.
- **Backups:** liegen im Container unter `/opt/origami/data/backups`.
- **Logs:** `pct exec <CTID> -- journalctl -u origami -f`

Ein vollständiges Home-Assistant-Backup ersetzt das eingebaute Backup nicht. Vor größeren Änderungen trotzdem ein HA-Backup ziehen.

---

## Manueller Modus (ohne Schreibzugriff)

Im Assistenten lässt sich ein **Bundle** als `tar.gz` herunterladen. Es enthält:

- Theme, Fonts, Bubble-Card-Module und Wetterbilder
- ein `configuration.yaml`-Snippet
- das fertige Dashboard-YAML
- eine `README.txt` mit allen Schritten
- `plugins.txt` mit den gepinnten Plugin-Versionen und Links

Damit kannst du alles über Samba, Studio Code Server oder SSH selbst nach `/config` kopieren. Das Bundle enthält Origami-Dateien und unterliegt damit der AGPL-3.0.

---

## Grenzen von v0.1

- Keine Raum-Pop-ups: Ein Tipp auf eine Raumkarte öffnet den normalen Mehr-Info-Dialog.
- Keine Musik-, TV-, Saugroboter-, Server- oder Favoriten-Ansichten.
- Keine Szenen im Lichter-Pop-up, weil die Origami-Szenen in jedem Haushalt anders heißen.
- Keine HACS-Abhängigkeit: Plugins werden direkt installiert.
- Kein Schreiben in Home Assistant ohne eingebundenes `/config`.
- Nur Proxmox-LXC als Installationsweg; Docker/Standalone ist noch nicht dabei.
- Die Oberfläche ist für das lokale Netz gedacht, nicht für das offene Internet.

---

## Appliance aktualisieren

Die Appliance ist ein normales Git-Checkout auf dem Proxmox-Host. Der Installer legt neue Container an; für ein Update im **bestehenden** Container die Dateien übernehmen:

```bash
cd ~/Origami-HA-Dashboard
git pull

# App + Skripte in den Container bringen
tar czf /tmp/origami-update.tgz app scripts
pct push <CTID> /tmp/origami-update.tgz /root/origami-update.tgz
pct exec <CTID> -- tar xzf /root/origami-update.tgz -C /opt/origami

# systemd-Unit aktualisieren (Sandbox/Härtung)
pct push <CTID> config/origami.service /etc/systemd/system/origami.service
pct exec <CTID> -- systemctl daemon-reload
pct exec <CTID> -- systemctl restart origami
pct exec <CTID> -- rm -f /root/origami-update.tgz
```

Nach dem Update im Wizard erneut **Zugriff prüfen** und die Installation wiederholen. Der Apply ist idempotent: vorhandene Dateien, Plugins und Ressourcen werden nicht doppelt angelegt.

> Achte darauf, dass `app/server/config.js` und `app/server/plugins.js` zusammenpassen: Tag und SHA-256 gehören immer zu einem Versionspaar.

---

## Sicherheit und Datenschutz

**Bedrohungsmodell:** Die Appliance ist für ein vertrauenswürdiges lokales Netz gedacht – nicht für das offene Internet. Wer den Setup-Code hat, kann den Long-Lived Token setzen und damit Home Assistant vollständig steuern. Behandle den Container wie einen Admin-Zugang zu deinem Smart Home.

### Zugriff und Anmeldung

- Der Dienst läuft als **root innerhalb eines unprivilegierten LXC**. Das ist nötig, weil der eingebundene `/config`-Ordner der Container-Root-UID gehört. Der Container hat keine Root-Rechte auf dem Proxmox-Host.
- Die Oberfläche ist mit einem **48-Bit-Setup-Code** geschützt (12 Hex-Zeichen, zufällig erzeugt, Datei `0600`). Er steht im Container unter `/opt/origami/setup-code`.
- Login-Fehlversuche werden **pro IP** begrenzt (10 Versuche, dann 10 Minuten Sperre). Das Session-Cookie ist `HttpOnly`, `SameSite=Lax`, 12 Stunden gültig und wird hinter HTTPS automatisch mit `Secure` gesetzt.
- `DISABLE_AUTH=1` ist **nur für Entwicklung** gedacht. In der Appliance ist es nicht gesetzt.
- Der Setup-Code ist kein Passwort für Dauerbetrieb: Nach der Einrichtung kannst du ihn durch Löschen von `/opt/origami/setup-code` und Neustart des Dienstes neu erzeugen.

### Transportverschlüsselung

- Die Appliance bringt **kein TLS** mit. Im LAN ist HTTP üblich; für alles darüber hinaus einen Reverse Proxy davorschalten (Caddy, nginx, Traefik) und nur dessen Port veröffentlichen.
- Hinter einem Proxy `TRUST_PROXY=1` setzen, damit `X-Forwarded-For`/`X-Forwarded-Proto` ausgewertet werden. **Ohne Proxy nicht setzen** – sonst lässt sich das Rate-Limit per Header umgehen.
- Beispiel nginx:

  ```nginx
  server {
    listen 443 ssl;
    server_name origami.example.lan;
    # ssl_certificate …;
    location / {
      proxy_pass http://10.0.0.42:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
  }
  ```

### Netzwerk und Firewall

- Port `8080` nur aus dem Admin-Netz erreichbar machen, z. B. auf dem Proxmox-Host:

  ```bash
  iptables -A INPUT -p tcp --dport 8080 -s 10.0.0.0/24 -j ACCEPT
  iptables -A INPUT -p tcp --dport 8080 -j DROP
  ```

- Der Container braucht ausgehend nur HTTPS (GitHub/jsDelivr) und die Home-Assistant-IP. Wenn du die Plugin-Downloads vorher cachest, kann er nach der Installation offline bleiben.

### Token und Home-Assistant-Zugriff

- Der Long-Lived Token wird mit **AES-256-GCM** verschlüsselt in `data/state.json` gespeichert; der Schlüssel liegt in `data/secret.key` (Modus `0600`, Verzeichnis `0700`).
- Der Token verlässt den Container nicht. Es gibt keine Cloud, keine Telemetrie und keinen externen Dienst außer GitHub/jsDelivr für die Downloads.
- Erzeuge den Token möglichst für einen **eigenen HA-Benutzer** mit Admin-Rechten und widerrufe ihn (Profil → Sicherheit → Token), wenn du die Appliance entfernst.
- Das Schreiben nach `/config` ist mächtig: Die Appliance kann Themes, Ressourcen, Integrationen und Dashboards ändern. Vor jedem Schreiben entsteht ein Backup; Rollback ist eingebaut.

### Downloads und Updates

- Origami und alle Plugins sind auf **unveränderliche Tags** gepinnt.
- Für Origami und jedes Plugin ist eine **SHA-256-Prüfsumme** hinterlegt. Stimmt sie nicht, bricht die Installation ab und es wird nichts geschrieben. Ein `main`-Fallback gibt es nicht.
- Beim Aktualisieren einer Version müssen Tag und Prüfsumme gemeinsam geändert werden (`app/server/plugins.js`, `app/server/config.js`).
- Die Prüfsummen werden beim Download **und** bei der Wiederverwendung aus dem Cache geprüft.

### Härtung des Dienstes

- systemd sandboxt den Prozess: `ProtectSystem=strict`, `ProtectHome`, `PrivateDevices`, `ProtectKernel*`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077`.
- Die Capability-Liste ist auf `CAP_DAC_OVERRIDE` reduziert – nur das, was zum Schreiben in den bind-gemounteten `/config` nötig ist.
- Der Container wird **ohne** `nesting`/`keyctl` erstellt.

### Samba und Credentials

- Das Samba-Add-on sollte einen **eigenen Benutzer** und ein starkes Passwort bekommen; `allow_hosts` auf die Proxmox-IP bzw. das Admin-Netz begrenzen.
- Die Zugangsdaten liegen auf dem Proxmox-Host in `/etc/origami-cifs.credentials` (Modus `0600`) und werden für `/etc/fstab` verwendet.
- Der Share ist für den Container beschreibbar. Wer Zugriff auf den Container oder den Proxmox-Host hat, kann daher auch Home Assistants `/config` ändern.

### Backups

- Backups liegen unter `/opt/origami/data/backups` **im Container**. Sie schützen gegen einen fehlgeschlagenen Apply, nicht gegen Verlust des Containers oder Datastores. Kopiere sie regelmäßig auf ein anderes System.
- Für HAOS zusätzlich die eingebauten Home-Assistant-Backups nutzen.

### Bekannte Restrisiken

- Kein Mehrbenutzerbetrieb, keine Rollen, kein Audit-Log: Die Appliance ist ein Ein-Personen-Setup-Werkzeug.
- Plugin-Code läuft später im Browser bzw. in Home Assistant. Die Prüfsummen garantieren, dass du genau die geprüfte Version installierst – sie bewerten den Code nicht.
- Die Home-Assistant-URL ist frei wählbar: Wer den Setup-Code hat, kann den Container als HTTP-Client in dein Netz nutzen (SSRF). Das ist bei einem Admin-Setup-Werkzeug beabsichtigt, aber ein Grund, Port `8080` nicht öffentlich zu machen.
- Wenn der Container kompromittiert wird, sind der HA-Token und der Schreibzugriff auf `/config` kompromittiert. Netzwerksegmentierung und ein eigener HA-Benutzer begrenzen den Schaden.

---

## Launch-Checkliste

Vor dem ersten öffentlichen Lauf einmal durchgehen:

- [ ] `bash test/lint.sh` läuft grün (Bash-Syntax, ShellCheck, Node-Syntax, Tests).
- [ ] Frischer Proxmox-Host: `bash install/origami.sh --check` zeigt keine Konflikte.
- [ ] Installation in einem **neuen** Container getestet, nicht nur im Entwicklungscontainer.
- [ ] `/config`-Mount überlebt einen Reboot des Proxmox-Hosts (`mount -a`, `fstab` mit `nofail`).
- [ ] Wizard-Login mit falschem Code: nach 10 Versuchen kommt `429`.
- [ ] Apply auf einer **Test-HA-Instanz** mit Backup und Rollback geprüft.
- [ ] Dashboard unter `/origami-dashboard` erreichbar, Ressourcen nach HA-Neustart vorhanden.
- [ ] Port `8080` ist nicht aus dem Internet erreichbar (Port-Check von außen).
- [ ] `README`, `docs/TROUBLESHOOTING.md` und Screenshots passen zur aktuellen Version.
- [ ] Lizenzhinweis (AGPL-3.0) und Origami-Attribution sichtbar.
- [ ] Tag/Release `v0.1.0` erstellen, danach Änderungen nur noch über Tags.

---

## Häufige Fragen

**Brauche ich HACS?**
Nein. Die Plugins werden direkt von GitHub/jsDelivr installiert und als Ressource eingetragen.

**Wird meine Home-Assistant-Konfiguration überschrieben?**
Nein. Es werden Dateien ergänzt und `configuration.yaml` vorsichtig gepatcht. Vorher entsteht ein Backup; Rollback ist eingebaut.

**Warum ein eigener Container und kein Home-Assistant-Add-on?**
Weil die Appliance auch für HAOS-VMs, HA-Container und HA-LXCs funktionieren soll und Dateien in `/config` schreiben muss. Ein Add-on gäbe es nur für HAOS.

**Kann ich das Dashboard später anpassen?**
Ja. Es ist ein normales Storage-Dashboard und lässt sich im Home-Assistant-Dashboard-Editor bearbeiten. Ein erneuter Lauf des Assistenten überschreibt es wieder.

**Was passiert bei einem Origami-Update?**
Der Installer ist auf `V3.0` gepinnt und prüft beim Download eine SHA-256-Prüfsumme. Ein Update auf eine neue Origami-Version ist bewusst ein eigener Schritt, damit sich nichts unbemerkt ändert.

**Kostet das etwas?**
Nein. Das Projekt ist quelloffen; es fallen nur die Kosten für deinen Proxmox-Host an.

**Kann ich es wieder entfernen?**
Ja: Rollback im Assistenten, danach `pct stop <CTID> && pct destroy <CTID>`. Der HA-Mount kann in `/etc/fstab` entfernt werden.

---

## Fehlersuche

Die ausführliche Sammlung steht in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Die häufigsten Fälle:

| Problem | Lösung |
| --- | --- |
| Kein Container nach der Bestätigung | `bash install/origami.sh --check`, dann die Fehlermeldung von `pct create` prüfen |
| „ID … is already used“ | ID gehört zu einer VM (z. B. HAOS); nächste freie ID nehmen oder `--id` setzen |
| „Bridge … does not exist“ | `--bridge vmbr1` (o. ä.) mitgeben; `--check` listet die Bridges |
| „Kein Schreibzugriff“ | `/config` einbinden (Schritt 2) und **Zugriff prüfen** |
| 401 vom Token | Neuen Long-Lived Token mit Admin-Rechten erzeugen |
| Dashboard leer / „Custom element doesn't exist“ | HA neu starten, Ressourcen prüfen, Seite hart neu laden |
| Theme fehlt | Im Profil `Origami` auswählen; `frontend:`-Patch prüfen |
| Dienst startet nicht | `pct exec <CTID> -- journalctl -u origami -n 80` |
| Oberfläche nicht erreichbar | Container-IP und Port 8080 prüfen, Firewall auf dem Host |

---

## Entwicklung

```bash
cd app
npm install
npm test          # Unit- und HTTP-Smoke-Tests
npm start         # UI auf http://localhost:8080 (DATA_DIR=./data)

# Auf dem Host:
bash test/lint.sh
bash install/origami.sh --dry-run
```

Die Tests brauchen kein Home Assistant. Der Vendor-Stand wird beim ersten Plan/Apply nach `app/data/vendor/origami-V3.0` geladen (nicht im Repo).

Mehr Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Mitmachen

Issues und Pull Requests sind willkommen. Bitte halte dich an den vorhandenen Stil (deutsche UI-Texte, Node ESM, kein Build-Schritt im Frontend) und ergänze bei Verhaltensänderungen einen Test.

---

## Danke

- [Origami](https://github.com/hazymorning/origami) von hazymorning – Design, Templates und Module
- [Bubble Card](https://github.com/Clooos/Bubble-Card) und [Bubble Card Tools](https://github.com/Clooos/Bubble-Card-Tools) von Clooos
- [Navbar Card](https://github.com/joseluis9595/lovelace-navbar-card) von joseluis9595
- [Origami Header](https://github.com/hazymorning/origami_header), [Notifications](https://github.com/hazymorning/origami_notifications), [Weather](https://github.com/hazymorning/origami_weather)

---

## Lizenz

Der eigene Code steht unter **AGPL-3.0-or-later**. Das ist nötig, weil das erzeugte Dashboard und das Bundle aus Origami-Vorlagen abgeleitet sind, die unter AGPL-3.0 stehen. Siehe [LICENSE](LICENSE).
