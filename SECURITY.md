# Sicherheit

## Unterstützte Versionen

Sicherheitsupdates gibt es für die jeweils aktuelle Release-Version. Ältere Stände bitte auf den neuesten Tag aktualisieren.

| Version | Unterstützt |
| --- | --- |
| `0.1.x` | ja |
| älter | nein |

## Eine Schwachstelle melden

Bitte **kein öffentliches Issue** für Sicherheitslücken. Nutze stattdessen [GitHub Security Advisories](https://github.com/HatchetMan111/Origami-HA-Dashboard/security/advisories/new) oder kontaktiere den Maintainer direkt über das GitHub-Profil.

Hilfreich sind:

- betroffene Version bzw. Commit,
- eine kurze Beschreibung und Auswirkung,
- Schritte zum Nachstellen (idealerweise mit einer Wegwerf-HA-Instanz),
- ob der Fehler ohne Setup-Code ausnutzbar ist.

Du bekommst eine Eingangsbestätigung, sobald die Meldung gesehen wurde. Bitte gib uns Zeit für ein Update, bevor du Details veröffentlichst.

## Geltungsbereich

Dieses Repository enthält den **Setup-Assistenten**, nicht Home Assistant oder Origami selbst. In den Geltungsbereich fallen:

- der Node-Dienst in `app/server/`,
- die Weboberfläche in `app/web/`,
- Installer und Mount-Skripte in `install/` und `scripts/`,
- die systemd-Unit und die Container-Konfiguration.

Nicht in den Geltungsbereich fallen Sicherheitslücken in Home Assistant, Bubble Card, Origami oder anderen installierten Plugins. Melde diese bitte beim jeweiligen Projekt.

## Sicherheitsmodell

Die Appliance ist für ein vertrauenswürdiges lokales Netz gedacht. Wer den Setup-Code oder Root-Zugriff auf den Container bzw. Proxmox-Host hat, kann Home Assistant vollständig steuern. Details, Härtung und Restrisiken stehen in der [README](README.md#sicherheit-und-datenschutz).
