# Origami-LXC

Eine kleine Proxmox-Appliance, die das [Origami-Dashboard](https://github.com/hazymorning/origami) in eine **bestehende** Home-Assistant-Installation einbaut – Theme, Fonts, Bubble-Card-Module, Plugins, Helfer und die Dashboard-Views. Danach öffnest du die Home-Assistant-Companion-App und hast ein Origami-Dashboard auf dem Handy.

Die Appliance ist kein Fork von Home Assistant und ersetzt keine Installation. Sie ist ein Einrichtungsassistent im eigenen LXC-Container, der über die Home-Assistant-REST- und WebSocket-API arbeitet und Dateien in `/config` ablegt.

> **Status: v0.1 (MVP).** Der Home-View mit Begrüßung, Wetter, Raumkarten, Klima-Tabelle, Lichter-Pop-up und Navigationsleiste wird installiert. Raum-Pop-ups, Musik, TV, Saugroboter, Favoriten und weitere Origami-Ansichten folgen in v0.2.

## Was du bekommst

| Teil | Details |
| --- | --- |
| Theme | `themes/origami.yaml` + Montserrat-Fonts unter `www/fonts` |
| Module | Origami-Bubble-Card-Module unter `bubble_card/modules` |
| Wetterbilder | Diorama-Assets unter `www/origami/weather` (lokal, kein CDN) |
| Plugins | Bubble Card, Bubble Card Tools, Origami Header, Origami Notifications, Origami Weather, Navbar Card – gepinnte Versionen, direkt von GitHub/jsDelivr |
| Dashboard | Dashboard `Origami` mit Pfad `/origami` |
| Helfer | `input_boolean.all_rooms`, `input_boolean.climate_table` |
| Sicherheit | Backup vor dem Schreiben, Rollback, Setup-Code für die Oberfläche |

Origami selbst wird **nicht** mitgeliefert. Der Container lädt beim Installieren den gepinnten Stand `V3.0` von GitHub – so bleibt die Lizenz sauber und du bekommst genau die Vorlagen, aus denen das Dashboard gebaut wird.

## Voraussetzungen

- Proxmox VE 8 oder neuer, Root-Zugriff auf den Host
- Eine laufende Home-Assistant-Installation (HAOS-VM, HA in einem LXC oder Container)
- Ein **Long-Lived Access Token** aus Home Assistant: Profil → Sicherheit → Long-Lived Access Tokens
- Schreibzugriff auf Home Assistants `/config` für Theme, Fonts und Plugins
  - **HAOS:** „Samba share“-Add-on aktivieren und den Share auf dem Proxmox-Host einbinden
  - **HA im LXC:** dessen Config-Pfad direkt bind-mounten
- Netzwerk: der Container muss Home Assistant und GitHub erreichen; dein Handy muss den Container erreichen

> Ohne Schreibzugriff auf `/config` funktioniert nur der lesende Teil (Verbinden, Zuordnen, Plan). Für die manuelle Installation gibt es ein Bundle (siehe unten).

## Schnellstart

Auf dem **Proxmox-Host** als root:

```bash
git clone https://github.com/HatchetMan111/Origami-Proxmox.git
cd Origami-Proxmox
bash install/origami.sh
```

Der Installer fragt nach einer Bestätigung, legt einen Debian-13-LXC an, installiert Node.js 22 und startet den Dienst. Am Ende zeigt er Adresse und Setup-Code:

```
Setup wizard   http://192.168.1.50:8080
Setup code     AB12CD34
```

Optionen (Auszug):

```bash
bash install/origami.sh --id 120 --ip 192.168.1.50/24 --gw 192.168.1.1 \
  --ha-config /tank/ha/config --port 8080
```

`--dry-run` zeigt nur, was passieren würde. Alle Optionen: `bash install/origami.sh --help`.

> `--ha-config` erwartet einen **bereits dauerhaft gemounteten** Pfad auf dem Host. Für HAOS ist der spätere Samba-Weg meist einfacher.

### 1. `/config` einbinden (HAOS)

Wenn du den Container ohne `--ha-config` installiert hast, kannst du den Zugriff später nachziehen. Auf dem Proxmox-Host:

```bash
bash install/ha-mount.sh --ctid 120 \
  --smb '//192.168.1.10/config' --user homeassistant --pass 'dein-passwort'
```

Das mountet den Samba-Share und hängt ihn als `/ha-config` in den Container. Der Eintrag landet in `/etc/fstab` und übersteht Reboots.

- In HAOS das Add-on **Samba share** installieren, Benutzer und Passwort setzen, Konfigurationsordner freigeben.
- Läuft Home Assistant in einem eigenen LXC, nutze `--path /pfad/zu/config` oder `--ha-ctid <id>`.

### 2. Assistent öffnen

`http://<container-ip>:8080` im Browser öffnen und den Setup-Code eingeben.

1. **Verbinden** – HA-URL (z. B. `http://192.168.1.10:8123`) und Long-Lived Token eintragen.
2. **Zuordnen** – Räume, Lichter, Temperatur-/Feuchte-/Fenster-Sensoren, Wetter, Kalender prüfen. Vorschläge kommen aus Bereichen und Geräteklassen; alles ist änderbar.
3. **Installieren** – Optionen wählen, Plan ansehen, installieren. Der Assistent schreibt ein Backup, installiert Dateien und Plugins, legt Ressourcen, Helfer und das Dashboard an und prüft das Ergebnis.
4. **Neustart** – Bubble Card Tools ist eine Integration; danach Home Assistant neu starten (Knopf im Assistenten).

### 3. Auf dem Handy

- Home-Assistant-Companion-App öffnen und den Server hinzufügen.
- Profil → Theme **Origami** auswählen.
- Dashboard **Origami** öffnen (Sidebar oder als Start-Dashboard in der Companion-App).

## Manueller Modus (ohne Schreibzugriff)

Im Assistenten lässt sich ein **Bundle** als `tar.gz` herunterladen. Es enthält Theme, Fonts, Module, Wetterbilder, ein `configuration.yaml`-Snippet, das fertige Dashboard-YAML und eine Schritt-für-Schritt-Anleitung. Damit kannst du alles über Samba, Studio Code Server oder SSH selbst nach `/config` kopieren.

Das Bundle enthält Origami-Dateien und unterliegt damit der AGPL-3.0 (siehe unten).

## Was v0.1 bewusst nicht macht

- Keine Raum-Pop-ups, Musik-/TV-/Staubsauger-/Favoriten-Ansichten
- Keine Szenen im Lichter-Pop-up (die Origami-Szenen heißen in jedem Haushalt anders)
- Keine HACS-Abhängigkeit: Plugins werden direkt installiert
- Kein Schreiben in Home Assistant, wenn `/config` nicht eingebunden ist
- Kein automatisches Anlegen von Lovelace-Ressourcen per YAML – das läuft über die WebSocket-API

## Sicherheit

- Der Dienst läuft als root **innerhalb eines unprivilegierten LXC**. Das ist nötig, weil der eingebundene `/config`-Ordner auf dem Host der Container-Root-UID gehört; ein eigener Dienstbenutzer käme dort nicht an die Dateien. Der Container selbst hat keine Root-Rechte auf dem Proxmox-Host.
- Der Long-Lived Token wird mit AES-256-GCM verschlüsselt in `data/state.json` abgelegt; der Schlüssel liegt in `data/secret.key` (Modus `0600`, Verzeichnis `0700`).
- Die Weboberfläche ist mit einem Setup-Code geschützt (Session-Cookie, 12 h). Der Code steht in `/opt/origami/setup-code`.
- Der Assistent lauscht im lokalen Netz; er sollte nicht direkt aus dem Internet erreichbar sein. Für Fernzugriff den Home-Assistant-Zugang oder ein VPN nutzen.
- Vor jedem Schreiben wird ein Backup der betroffenen Dateien unter `data/backups` angelegt. Rollback ist im Assistenten möglich.

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

Mehr Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) und [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Mitmachen

Issues und Pull Requests sind willkommen. Bitte halte dich an den vorhandenen Stil (deutsche UI-Texte, Node ESM, keine Build-Schritte im Frontend) und ergänze bei Verhaltensänderungen einen Test.

## Danke

- [Origami](https://github.com/hazymorning/origami) von hazymorning – das Design, die Templates und die Module
- [Bubble Card](https://github.com/Clooos/Bubble-Card) und [Bubble Card Tools](https://github.com/Clooos/Bubble-Card-Tools) von Clooos
- [Navbar Card](https://github.com/joseluis9595/lovelace-navbar-card) von joseluis9595
- [Origami Header](https://github.com/hazymorning/origami_header), [Notifications](https://github.com/hazymorning/origami_notifications), [Weather](https://github.com/hazymorning/origami_weather)

## Lizenz

Der eigene Code steht unter AGPL-3.0-or-later. Das ist nötig, weil das erzeugte Dashboard und das Bundle aus Origami-Vorlagen abgeleitet sind, die unter AGPL-3.0 stehen. Siehe [LICENSE](LICENSE).
