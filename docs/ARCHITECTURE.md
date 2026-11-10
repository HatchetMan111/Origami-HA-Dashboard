# Architektur

## Überblick

```
Proxmox-Host
├── install/origami.sh          legt LXC an, mountet /ha-config, startet Installation
├── install/ha-mount.sh         Samba/Bind-Mount für Home Assistants /config
└── LXC „origami“
    ├── /opt/origami/app        Node-App (kein Build-Schritt)
    ├── /opt/origami/data       Zustand, Cache, Backups, Vendor-Download
    ├── /ha-config              Bind-Mount von Home Assistants /config
    └── systemd: origami.service → node server/index.js (Port 8080)
```

Die App ist ein einzelner Node-Prozess mit einer Vanilla-JS-Oberfläche. Es gibt keine Datenbank und keinen Build-Schritt; der einzige npm-Dependency ist `yaml`.

## Ablauf

1. **Installieren (Host)** – `origami.sh` wählt ein Debian-Template, erzeugt einen unprivilegierten LXC mit `nesting=1,keyctl=1`, wartet auf Netzwerk, pusht das App-Tar und ruft `scripts/install-inside.sh` auf. Dort werden Node.js 22 (offizielles Tarball, per SHA256 geprüft), die App, der Setup-Code und die systemd-Unit installiert.
2. **Verbinden** – Der Assistent (`POST /api/connect`) prüft URL und Token über die HA-REST-API, liest Version, Standort und Einheitensystem und verschlüsselt den Token.
3. **Zuordnen** – `GET /api/discover` liest States, Area-/Device-/Entity-Registries. `discover.js` schlägt Räume (nach Area) und globale Entitäten (Wetter, Kalender, Gruppe, Mediaplayer) vor. Der Nutzer korrigiert die Zuordnung; `POST /api/mapping` validiert und speichert sie.
4. **Planen** – `POST /api/plan` lädt bei Bedarf den Origami-Vendor-Stand und baut das Dashboard im Speicher. Der Plan zeigt Karten, Helfer, Plugins, Dateien und fehlende Entitäten.
5. **Installieren** – `POST /api/apply` startet einen Job. `apply.js` prüft `/config`, legt ein Backup an, kopiert Theme/Fonts/Module/Assets, lädt Plugins, ergänzt `configuration.yaml`, legt Lovelace-Ressourcen, Helfer und das Dashboard an und prüft das Ergebnis.
6. **Neustart** – Bubble Card Tools ist eine Custom Integration und wird erst nach einem HA-Neustart geladen. `POST /api/restart` startet HA und wartet, bis es wieder antwortet.
7. **Rollback** – `POST /api/rollback` entfernt Dashboard, Ressourcen und Helfer und stellt die gesicherten Dateien aus dem Backup wieder her.

Jobs laufen asynchron; Fortschritt und Logs kommen als Server-Sent Events über `/api/job/:id/events`.

## Dateien in Home Assistant

| Ziel | Quelle |
| --- | --- |
| `themes/origami.yaml` | Origami-Release |
| `www/fonts/*` | Origami-Release |
| `bubble_card/modules/*.yaml` | Origami-Release |
| `www/origami/weather/{diorama,house}/*` | Origami-Release (nur bei `localAssets`) |
| `www/community/<plugin>/…` | jsDelivr/GitHub, gepinnte Tags |
| `custom_components/bubble_card_tools/` | GitHub-Release-Tarball |
| `configuration.yaml` | gepatcht: `frontend.themes`, `frontend.extra_module_url` |

Der Patch ist absichtlich konservativ: Er ergänzt nur einen `frontend:`-Block bzw. fehlende Schlüssel. Ein Inline-Wert wie `frontend: !include frontend.yaml` wird nicht angefasst, sondern als Warnung im Plan gemeldet.

## Dashboard-Generator

`server/generate.js` liest die Origami-YAML-Vorlagen aus `data/vendor/origami-V3.0`, ersetzt Beispiel-Entitäten durch die Zuordnung und baut daraus eine Sections-View.

- **Mapping**: Beispiel-IDs (`light.living_room`, `sensor.living_room_temperature`, …) werden rekursiv in Strings ersetzt. Längere IDs zuerst, damit `light.living_room_tv` nicht von `light.living_room` zerschnitten wird.
- **Räume**: `rooms/header.yaml` bekommt die echten Sensorlisten, `rooms/room.yaml` wird pro Raum geklont und mit dessen Entitäten gemappt.
- **Klima-Tabelle**: Die Temperatur-/Feuchte-Listen in den Zellen-Templates werden durch die echten Raum-Sensoren ersetzt; pro Raum wird die Zeile aus der Vorlage geklont und gefiltert (Fenster, Thermostat, Feuchte nur wenn vorhanden).
- **Lichter**: Das Pop-up behält die Lampen-Slider und den Gruppen-Schalter. Szenen werden entfernt, weil sie haushaltsspezifisch sind.
- **Navigation**: Nur Routen, deren Pop-up wirklich existiert (Lichter, optional Menü). Musik/TV/Favoriten entfallen in v0.1.
- **Pruning**: Buttons mit unbekannten Entitäten werden entfernt, bevor sie ins Dashboard kommen. `findMissingEntities` scannt das Ergebnis und ignoriert Service-Namen (`light.turn_on`, …), damit der Plan keine falschen Warnungen zeigt.

Diese String-Ersetzung ist bewusst pragmatisch: Sie funktioniert mit dem gepinnten Origami-Stand und bricht bei einem großen Upstream-Umbau sichtbar (Tests + fehlende Entitäten), statt still ein falsches Dashboard zu bauen. v0.2 soll die restlichen Views ergänzen und die Vorlagen stärker strukturell bearbeiten.

## Zustand und Sicherheit

- `data/state.json` – Verbindung, Mapping, Optionen, letzter Plan, Installationsstand, Historie (Modus `0600`)
- `data/secret.key` – 32-Byte-Schlüssel für AES-256-GCM
- `data/setup-code` bzw. `/opt/origami/setup-code` – Login-Code
- `data/cache` – geprüfte Plugin-Downloads
- `data/backups` – HA-Config-Backups (nur relevante Pfade) und temporäre Bundles
- `data/vendor` – entpackter Origami-Stand

Die Oberfläche nutzt ein signiertes Session-Cookie mit 12 h Laufzeit, Login-Rate-Limit pro IP und denselben Setup-Code wie der Installer. Der Token verlässt den Container nicht. Der Dienst läuft als root im unprivilegierten Container, weil der Bind-Mount der HA-Config sonst nicht beschreibbar wäre.

## Grenzen

- Die Appliance braucht Schreibzugriff auf `/config`. Ohne Mount bleibt nur der manuelle Bundle-Weg.
- Die HA-WebSocket-Verbindung wird pro Vorgang geöffnet und wieder geschlossen; es gibt keinen dauerhaften Listener.
- Dashboard-Konfiguration wird über die Lovelace-WebSocket-API gespeichert, nicht als YAML-Datei. Dadurch funktioniert es auch im UI-Modus.
- Ein Home-Assistant-Neustart wird nicht erzwungen; der Assistent weist darauf hin.

## Tests

- `test/unit/generate.test.js`: Config-Patch, Discovery, Dashboard-Generierung gegen den echten Vendor-Stand (wird übersprungen, wenn nicht synchronisiert)
- `test/smoke/http.test.js`: startet den Server mit temporärem `DATA_DIR` und `DISABLE_AUTH=1`, prüft `/api/health`, `/`, `/api/session` und 404
- `test/lint.sh`: `bash -n`, optional `shellcheck`, `node --check`, Tests
