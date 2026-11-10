import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CACHE_DIR } from "./config.js";

const exec = promisify(execFile);

export const PLUGINS = [
  {
    key: "bubble-card",
    label: "Bubble Card",
    repo: "Clooos/Bubble-Card",
    tag: "v3.4.3",
    kind: "plugin",
    files: [{ from: "dist/bubble-card.js", to: "bubble-card.js" }],
    resource: "/local/community/bubble-card/bubble-card.js",
    required: true,
  },
  {
    key: "bubble-card-tools",
    label: "Bubble Card Tools",
    repo: "Clooos/Bubble-Card-Tools",
    tag: "v1.1.1",
    kind: "integration",
    folder: "bubble_card_tools",
    required: true,
  },
  {
    key: "origami-header",
    label: "Origami Header",
    repo: "hazymorning/origami_header",
    tag: "v0.4.3",
    kind: "plugin",
    files: [{ from: "origami-header.js", to: "origami-header.js" }],
    resource: "/local/community/origami-header/origami-header.js",
    extraModule: true,
  },
  {
    key: "origami-notifications",
    label: "Origami Notifications",
    repo: "hazymorning/origami_notifications",
    tag: "v1.6.0",
    kind: "plugin",
    files: [{ from: "dist/origami-notifications.js", to: "origami-notifications.js" }],
    resource: "/local/community/origami-notifications/origami-notifications.js",
  },
  {
    key: "origami-weather",
    label: "Origami Weather",
    repo: "hazymorning/origami_weather",
    tag: "V1.6.1",
    kind: "plugin",
    files: [{ from: "dist/origami-weather.js", to: "origami-weather.js" }],
    resource: "/local/community/origami-weather/origami-weather.js",
  },
  {
    key: "navbar-card",
    label: "Navbar Card",
    repo: "joseluis9595/lovelace-navbar-card",
    tag: "v1.8.0",
    kind: "plugin",
    files: [{ from: "navbar-card.js", to: "navbar-card.js" }],
    resource: "/local/community/navbar-card/navbar-card.js",
  },
];

export const PLUGIN_KEYS = PLUGINS.map((plugin) => plugin.key);

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 200) throw new Error(`Suspiciously small download (${buffer.length} B): ${url}`);
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

async function fetchPluginFile(plugin, file) {
  const cached = path.join(CACHE_DIR, `${plugin.key}-${plugin.tag}-${path.basename(file.to)}`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) return cached;

  const attempts = [
    `https://cdn.jsdelivr.net/gh/${plugin.repo}@${plugin.tag}/${file.from}`,
    `https://raw.githubusercontent.com/${plugin.repo}/${plugin.tag}/${file.from}`,
    `https://github.com/${plugin.repo}/releases/download/${plugin.tag}/${path.basename(file.to)}`,
  ];

  for (const url of attempts) {
    try {
      await download(url, cached);
      return cached;
    } catch (error) {
      /* try next */
    }
  }

  // Last resort: the tagged source tarball (useful when only release assets exist).
  const tarball = path.join(CACHE_DIR, `${plugin.key}-${plugin.tag}.tar.gz`);
  if (!fs.existsSync(tarball)) {
    await download(`https://codeload.github.com/${plugin.repo}/tar.gz/refs/tags/${plugin.tag}`, tarball);
  }
  const tmp = fs.mkdtempSync(path.join(CACHE_DIR, `${plugin.key}-`));
  await exec("tar", ["xzf", tarball, "-C", tmp]);
  const root = fs.readdirSync(tmp).find((entry) => fs.statSync(path.join(tmp, entry)).isDirectory());
  const source = path.join(tmp, root, file.from);
  if (!fs.existsSync(source)) throw new Error(`${plugin.label}: ${file.from} not found in ${plugin.tag}`);
  fs.copyFileSync(source, cached);
  fs.rmSync(tmp, { recursive: true, force: true });
  return cached;
}

export function isInstalled(plugin, configDir) {
  if (plugin.kind === "integration") {
    return fs.existsSync(path.join(configDir, "custom_components", plugin.folder, "manifest.json"));
  }
  return fs.existsSync(path.join(configDir, "www", "community", plugin.key, plugin.files[0].to));
}

export async function installPlugin(plugin, configDir, log = () => {}) {
  if (plugin.kind === "integration") {
    const target = path.join(configDir, "custom_components", plugin.folder);
    if (fs.existsSync(path.join(target, "manifest.json"))) return { key: plugin.key, skipped: true };
    const tarball = path.join(CACHE_DIR, `${plugin.key}-${plugin.tag}.tar.gz`);
    if (!fs.existsSync(tarball)) {
      log(`Lade ${plugin.label} ${plugin.tag} …`);
      await download(`https://codeload.github.com/${plugin.repo}/tar.gz/refs/tags/${plugin.tag}`, tarball);
    }
    const tmp = fs.mkdtempSync(path.join(CACHE_DIR, `${plugin.key}-`));
    await exec("tar", ["xzf", tarball, "-C", tmp]);
    const root = fs.readdirSync(tmp).find((entry) => fs.statSync(path.join(tmp, entry)).isDirectory());
    const source = path.join(tmp, root, "custom_components", plugin.folder);
    if (!fs.existsSync(source)) throw new Error(`${plugin.label}: custom_components/${plugin.folder} missing`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`${plugin.label} installiert (Integration, Neustart nötig).`);
    return { key: plugin.key, integration: true };
  }

  const targetDir = path.join(configDir, "www", "community", plugin.key);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of plugin.files) {
    log(`Lade ${plugin.label} ${plugin.tag} …`);
    const cached = await fetchPluginFile(plugin, file);
    fs.copyFileSync(cached, path.join(targetDir, file.to));
  }
  log(`${plugin.label} installiert.`);
  return { key: plugin.key, files: plugin.files.length };
}

export function pluginByKey(key) {
  return PLUGINS.find((plugin) => plugin.key === key);
}

export function resourcesFor(keys) {
  return PLUGINS.filter((plugin) => keys.includes(plugin.key) && plugin.resource).map((plugin) => ({
    key: plugin.key,
    url: plugin.resource,
    extraModule: Boolean(plugin.extraModule),
  }));
}

export function integrationKeys(keys) {
  return PLUGINS.filter((plugin) => keys.includes(plugin.key) && plugin.kind === "integration").map((plugin) => plugin.key);
}
