import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { BACKUP_DIR, DASHBOARD_ICON, DASHBOARD_TITLE, HA_CONFIG } from "./config.js";
import { installPlugin, isInstalled, pluginByKey, PLUGINS, resourcesFor } from "./plugins.js";
import { isSynced, syncVendor, vendorPath } from "./vendor.js";

const exec = promisify(execFile);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function configAccess() {
  const result = { path: HA_CONFIG, exists: fs.existsSync(HA_CONFIG), writable: false, valid: false, message: "" };
  if (!result.exists) {
    result.message = "Der Ordner /ha-config ist nicht eingebunden.";
    return result;
  }
  const marker = path.join(HA_CONFIG, "configuration.yaml");
  result.valid = fs.existsSync(marker);
  try {
    const probe = path.join(HA_CONFIG, `.origami-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    result.writable = true;
  } catch (error) {
    result.message = `Kein Schreibzugriff: ${error.code || error.message}`;
    return result;
  }
  result.message = result.valid
    ? "Schreibzugriff auf Home Assistants /config."
    : "Ordner ist beschreibbar, sieht aber nicht wie eine HA-Konfiguration aus (configuration.yaml fehlt).";
  return result;
}

export function installedPlugins() {
  return PLUGINS.filter((plugin) => isInstalled(plugin, HA_CONFIG)).map((plugin) => plugin.key);
}

export async function backupConfig(log = () => {}) {
  if (!configAccess().writable) return null;
  const file = path.join(BACKUP_DIR, `ha-config-${stamp()}.tar.gz`);
  const candidates = [
    "configuration.yaml",
    "themes",
    "www/community",
    "www/origami",
    "www/fonts",
    "bubble_card",
    "custom_components/bubble_card_tools",
  ].filter((entry) => fs.existsSync(path.join(HA_CONFIG, entry)));
  if (!candidates.length) return null;
  await exec("tar", ["czf", file, "-C", HA_CONFIG, ...candidates]);
  log(`Backup: ${file}`);
  return file;
}

export async function restoreBackup(file) {
  if (!file || !fs.existsSync(file)) throw new Error("Backup nicht gefunden.");
  await exec("tar", ["xzf", file, "-C", HA_CONFIG]);
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return true;
}

export function installFiles(log = () => {}, options = {}) {
  const vendor = vendorPath();
  const created = [];

  const theme = path.join(HA_CONFIG, "themes", "origami.yaml");
  if (fs.existsSync(path.join(vendor, "themes", "origami.yaml"))) {
    fs.mkdirSync(path.dirname(theme), { recursive: true });
    fs.copyFileSync(path.join(vendor, "themes", "origami.yaml"), theme);
    created.push("themes/origami.yaml");
  }

  if (copyTree(path.join(vendor, "www", "fonts"), path.join(HA_CONFIG, "www", "fonts"))) {
    created.push("www/fonts");
  }

  const modules = path.join(HA_CONFIG, "bubble_card", "modules");
  fs.mkdirSync(modules, { recursive: true });
  const moduleDir = path.join(vendor, "bubble_card", "modules");
  for (const file of fs.readdirSync(moduleDir).filter((name) => name.endsWith(".yaml"))) {
    fs.copyFileSync(path.join(moduleDir, file), path.join(modules, file));
  }
  created.push("bubble_card/modules");

  if (options.localAssets) {
    for (const folder of ["diorama", "house"]) {
      if (copyTree(path.join(vendor, "dashboard", "weather", folder), path.join(HA_CONFIG, "www", "origami", "weather", folder))) {
        created.push(`www/origami/weather/${folder}`);
      }
    }
    fs.copyFileSync(path.join(vendor, "LICENSE"), path.join(HA_CONFIG, "www", "origami", "LICENSE"));
  }

  log(`Dateien installiert: ${created.length} Bereiche.`);
  return created;
}

export function patchConfiguration({ extraModuleUrls = [], themes = true } = {}) {
  const file = path.join(HA_CONFIG, "configuration.yaml");
  const original = fs.readFileSync(file, "utf8");
  const result = patchConfigurationText(original, { extraModuleUrls, themes });
  if (result.changed) {
    const backup = `${file}.origami-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, result.text);
  }
  return result;
}

export function patchConfigurationText(text, { extraModuleUrls = [], themes = true } = {}) {
  const lines = text.split(/\r?\n/);
  const findFrontend = () =>
    lines.findIndex((line) => /^frontend:\s*(#.*)?$/.test(line));

  if (lines.some((line) => /^frontend:\s+\S/.test(line))) {
    return {
      text,
      changed: false,
      warning:
        "frontend: hat bereits einen Inline-Wert. Bitte themes/extra_module_url manuell ergänzen (siehe configuration-snippet.yaml).",
    };
  }

  const start = findFrontend();
  if (start === -1) {
    const block = ["frontend:"];
    if (themes) block.push("  themes: !include_dir_merge_named themes");
    if (extraModuleUrls.length) {
      block.push("  extra_module_url:");
      for (const url of extraModuleUrls) block.push(`    - ${url}`);
    }
    const trimmed = text.replace(/\s*$/, "");
    return { text: `${trimmed}\n\n${block.join("\n")}\n`, changed: true };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const block = lines.slice(start, end);
  const hasThemes = block.some((line) => /^\s{2}themes:/.test(line));
  const extraKey = block.findIndex((line) => /^\s{2}extra_module_url:/.test(line));
  const insertAfterFrontend = [];
  let changed = false;

  if (themes && !hasThemes) {
    insertAfterFrontend.push("  themes: !include_dir_merge_named themes");
    changed = true;
  }

  if (extraModuleUrls.length) {
    if (extraKey === -1) {
      insertAfterFrontend.push("  extra_module_url:");
      for (const url of extraModuleUrls) insertAfterFrontend.push(`    - ${url}`);
      changed = true;
    } else {
      const missing = extraModuleUrls.filter((url) => !text.includes(url));
      if (missing.length) {
        lines.splice(start + extraKey + 1, 0, ...missing.map((url) => `    - ${url}`));
        changed = true;
      }
    }
  }

  if (insertAfterFrontend.length) lines.splice(start + 1, 0, ...insertAfterFrontend);
  return { text: lines.join("\n"), changed };
}

export function configurationSnippet(extraModuleUrls = []) {
  const lines = ["frontend:", "  themes: !include_dir_merge_named themes"];
  if (extraModuleUrls.length) {
    lines.push("  extra_module_url:");
    for (const url of extraModuleUrls) lines.push(`    - ${url}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function installPluginsAsync(keys, log = () => {}) {
  const installed = [];
  const warnings = [];
  for (const key of keys) {
    const plugin = pluginByKey(key);
    if (!plugin) continue;
    try {
      installed.push(await installPlugin(plugin, HA_CONFIG, log));
    } catch (error) {
      warnings.push(`${plugin.label}: ${error.message}`);
      log(`${plugin.label} fehlgeschlagen: ${error.message}`, "warn");
    }
  }
  return { installed, warnings };
}

export async function ensureResources(ha, pluginKeys, log = () => {}) {
  const wanted = [
    { key: "fonts", url: "/local/fonts/montserrat.css", type: "css" },
    ...resourcesFor(pluginKeys),
  ];
  const existing = await ha.resources();
  const byUrl = new Map((existing || []).map((resource) => [resource.url, resource]));
  const created = [];
  const warnings = [];
  for (const resource of wanted) {
    if (byUrl.has(resource.url)) continue;
    try {
      const result = await ha.createResource(resource.url, resource.type || "module");
      created.push({ ...resource, id: result?.id });
      log(`Ressource angelegt: ${resource.url}`);
    } catch (error) {
      warnings.push(`${resource.url}: ${error.message}`);
    }
  }
  return { created, warnings };
}

export async function ensureHelpers(ha, helpers, log = () => {}) {
  const created = [];
  for (const helper of helpers) {
    try {
      await ha.rest(`/api/states/${helper.entity}`);
      continue;
    } catch (error) {
      if (error.status !== 404) {
        log(`Helper ${helper.entity} konnte nicht geprüft werden: ${error.message}`, "warn");
        continue;
      }
    }
    try {
      const result = await ha.createHelper(helper.domain, { name: helper.name });
      created.push({ ...helper, id: result?.id });
      log(`Helper angelegt: ${helper.entity}`);
    } catch (error) {
      log(`Helper ${helper.entity} fehlgeschlagen: ${error.message}`, "warn");
    }
  }
  return created;
}

export async function ensureDashboard(ha, dashboard, log = () => {}) {
  const dashboards = await ha.dashboards();
  const existing = (dashboards || []).find((entry) => entry.url_path === dashboard.urlPath);
  let dashboardId = existing?.id;
  if (!existing) {
    const created = await ha.createDashboard({
      url_path: dashboard.urlPath,
      title: dashboard.title || DASHBOARD_TITLE,
      icon: dashboard.icon || DASHBOARD_ICON,
      show_in_sidebar: true,
    });
    dashboardId = created?.id;
    log(`Dashboard „${dashboard.title}“ angelegt.`);
  } else {
    log(`Dashboard „${dashboard.title}“ aktualisiert.`);
  }
  await ha.saveDashboard(dashboard.urlPath, dashboard.config);
  return dashboardId;
}

export async function reloadThemes(ha, log = () => {}) {
  try {
    await ha.rest("/api/services/frontend/reload_themes", { method: "POST", body: {} });
    log("Themes neu geladen.");
  } catch (error) {
    log(`Themes konnten nicht neu geladen werden: ${error.message}`, "warn");
  }
}

export async function verify(ha, dashboard, created = {}) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  for (const file of ["themes/origami.yaml", "www/fonts/montserrat.css", "bubble_card/modules/origami_base.yaml"]) {
    add(file, fs.existsSync(path.join(HA_CONFIG, file)));
  }

  try {
    const config = await ha.getDashboard(dashboard.urlPath);
    add("Dashboard lesbar", Boolean(config?.views?.length), `${config?.views?.length || 0} View(s)`);
  } catch (error) {
    add("Dashboard lesbar", false, error.message);
  }

  try {
    const resources = await ha.resources();
    const urls = new Set((resources || []).map((entry) => entry.url));
    add("Ressource Fonts", urls.has("/local/fonts/montserrat.css"), "/local/fonts/montserrat.css");
    for (const plugin of PLUGINS) {
      if (!created.plugins?.includes(plugin.key) || !plugin.resource) continue;
      add(`Ressource ${plugin.key}`, urls.has(plugin.resource), plugin.resource);
    }
  } catch (error) {
    add("Ressourcen", false, error.message);
  }

  return checks;
}

export async function applyAll({ ha, dashboard, mapping, options, log = () => {} }) {
  const access = configAccess();
  if (!access.writable || !access.valid) {
    const error = new Error(access.message || "Kein Schreibzugriff auf /config.");
    error.code = "NO_ACCESS";
    throw error;
  }

  if (!isSynced()) await syncVendor(log);
  log("Backup der HA-Konfiguration …");
  const backup = await backupConfig(log);

  const created = { files: [], plugins: [], resources: [], helpers: [], dashboardId: null, backup, configPatched: false };

  created.files = installFiles(log, options);

  const pluginKeys = PLUGINS.filter((plugin) => {
    if (plugin.key === "origami-header") return Boolean(options.menu);
    if (plugin.key === "origami-notifications") return Boolean(options.notifications);
    if (plugin.key === "origami-weather") return Boolean(options.weather);
    if (plugin.key === "navbar-card") return Boolean(options.navigationBar);
    return true;
  }).map((plugin) => plugin.key);

  const pluginResult = await installPluginsAsync(pluginKeys, log);
  created.plugins = pluginResult.installed.map((entry) => entry.key);
  const warnings = [...pluginResult.warnings];

  const extraModuleUrls = installedPlugins()
    .map((key) => pluginByKey(key))
    .filter((plugin) => plugin?.extraModule)
    .map((plugin) => plugin.resource);
  if (options.menu) {
    const header = pluginByKey("origami-header");
    if (header && !extraModuleUrls.includes(header.resource)) extraModuleUrls.push(header.resource);
  }

  const patch = patchConfiguration({ extraModuleUrls });
  created.configPatched = patch.changed;
  if (patch.warning) warnings.push(patch.warning);
  if (patch.changed) log("configuration.yaml ergänzt (Backup: configuration.yaml.origami-backup).");

  await reloadThemes(ha, log);

  const resourceResult = await ensureResources(ha, created.plugins, log);
  created.resources = resourceResult.created;
  warnings.push(...resourceResult.warnings);

  created.helpers = await ensureHelpers(ha, dashboard.helpers, log);
  created.dashboardId = await ensureDashboard(ha, dashboard, log);

  const checks = await verify(ha, dashboard, created);
  const restartRequired = created.plugins.includes("bubble-card-tools");

  return { created, checks, warnings, restartRequired, backup };
}

export async function rollback({ ha, created, log = () => {} }) {
  if (!created) throw new Error("Kein Apply-Status vorhanden.");
  const notes = [];

  if (created.dashboardId) {
    try {
      await ha.deleteDashboard(created.dashboardId);
      notes.push("Dashboard entfernt");
    } catch (error) {
      notes.push(`Dashboard: ${error.message}`);
    }
  }
  for (const resource of created.resources || []) {
    if (!resource.id) continue;
    try {
      await ha.deleteResource(resource.id);
      notes.push(`Ressource entfernt: ${resource.url}`);
    } catch (error) {
      notes.push(`Ressource ${resource.url}: ${error.message}`);
    }
  }
  for (const helper of created.helpers || []) {
    if (!helper.id) continue;
    try {
      await ha.deleteHelper(helper.domain, helper.id);
      notes.push(`Helper entfernt: ${helper.entity}`);
    } catch (error) {
      notes.push(`Helper ${helper.entity}: ${error.message}`);
    }
  }
  if (created.backup) {
    try {
      await restoreBackup(created.backup);
      notes.push("HA-Konfiguration aus Backup wiederhergestellt");
    } catch (error) {
      notes.push(`Backup: ${error.message}`);
    }
  }
  log(notes.join(" · ") || "Nichts zu entfernen.");
  return notes;
}

export async function buildBundle(dashboard, options, outFile) {
  if (!isSynced()) await syncVendor();
  const dir = fs.mkdtempSync(path.join(BACKUP_DIR, "bundle-"));
  fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
  fs.copyFileSync(path.join(vendorPath(), "themes", "origami.yaml"), path.join(dir, "themes", "origami.yaml"));
  fs.cpSync(path.join(vendorPath(), "www", "fonts"), path.join(dir, "www", "fonts"), { recursive: true });
  fs.cpSync(path.join(vendorPath(), "bubble_card", "modules"), path.join(dir, "bubble_card", "modules"), { recursive: true });
  fs.cpSync(path.join(vendorPath(), "dashboard", "weather"), path.join(dir, "www", "origami", "weather"), { recursive: true });
  const extraModuleUrls = [];
  if (options?.menu) {
    const header = pluginByKey("origami-header");
    if (header) extraModuleUrls.push(header.resource);
  }
  fs.writeFileSync(path.join(dir, "configuration-snippet.yaml"), configurationSnippet(extraModuleUrls));
  fs.writeFileSync(
    path.join(dir, "plugins.txt"),
    PLUGINS.map((plugin) =>
      [
        `${plugin.label} (${plugin.tag})`,
        `  https://github.com/${plugin.repo}/releases/tag/${plugin.tag}`,
        plugin.resource ? `  Ressource: ${plugin.resource}` : `  Integration: custom_components/${plugin.folder}`,
      ].join("\n"),
    ).join("\n\n") + "\n",
  );
  fs.writeFileSync(path.join(dir, "dashboard.yaml"), YAML.stringify(dashboard.config, { lineWidth: 0 }));
  fs.writeFileSync(
    path.join(dir, "README.txt"),
    [
      "Origami-LXC – manueller Modus",
      "",
      "Dateien",
      "  themes/origami.yaml     → /config/themes/origami.yaml",
      "  www/fonts               → /config/www/fonts",
      "  bubble_card/modules     → /config/bubble_card/modules",
      "  www/origami             → /config/www/origami",
      "  dashboard.yaml          → Dashboard „Origami“ (Rohkonfiguration)",
      "",
      "Schritte",
      "1. Ordner wie oben nach /config kopieren (Studio Code Server oder Samba).",
      "2. configuration-snippet.yaml in configuration.yaml übernehmen (frontend:) und HA neu starten.",
      "3. Plugins installieren und als Ressource eintragen – Versionen und Links stehen in plugins.txt:",
      "     Bubble Card, Bubble Card Tools (Integration), Origami Header,",
      "     Origami Notifications, Origami Weather, Navbar Card",
      "   Ressourcen: Einstellungen → Dashboards → Ressourcen",
      "     /local/fonts/montserrat.css                       (Stylesheet)",
      "     /local/community/bubble-card/bubble-card.js",
      "     /local/community/origami-notifications/origami-notifications.js",
      "     /local/community/origami-weather/origami-weather.js",
      "     /local/community/origami-header/origami-header.js   (als JavaScript-Modul)",
      "     /local/community/navbar-card/navbar-card.js",
      "4. Zwei Helfer anlegen (Einstellungen → Geräte & Dienste → Helfer):",
      "     input_boolean.all_rooms      (Name: All rooms)",
      "     input_boolean.climate_table  (Name: Climate table)",
      "5. Theme im Profil auswählen („Origami“) und dashboard.yaml als Dashboard",
      "   mit Pfad „origami“ anlegen.",
      "",
      "Origami: https://github.com/hazymorning/origami (AGPL-3.0)",
      "Diese Sammlung enthält Origami-Dateien und steht damit ebenfalls unter AGPL-3.0.",
    ].join("\n"),
  );
  await exec("tar", ["czf", outFile, "-C", dir, "."]);
  fs.rmSync(dir, { recursive: true, force: true });
  return outFile;
}
