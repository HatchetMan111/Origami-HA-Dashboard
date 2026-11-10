import { execFile } from "node:child_process";
import crypto from "node:crypto";
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
    files: [
      {
        from: "dist/bubble-card.js",
        to: "bubble-card.js",
        sha256: "51b54894e51624d8a4596a576ad82b084df69cc7c9473aeaa167f255e01fb396",
      },
    ],
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
    sha256: "466dac4756d19ca68db41bb4155176a6b561ed43b4b3c9e512a38b2ebc16444b",
    required: true,
  },
  {
    key: "origami-header",
    label: "Origami Header",
    repo: "hazymorning/origami_header",
    tag: "v0.4.3",
    kind: "plugin",
    files: [
      {
        from: "origami-header.js",
        to: "origami-header.js",
        sha256: "51fb872a6097276da9e98ef2fb913bb8913f50875b486e54c509571625b6c3e8",
      },
    ],
    resource: "/local/community/origami-header/origami-header.js",
    extraModule: true,
  },
  {
    key: "origami-notifications",
    label: "Origami Notifications",
    repo: "hazymorning/origami_notifications",
    tag: "v1.6.0",
    kind: "plugin",
    files: [
      {
        from: "dist/origami-notifications.js",
        to: "origami-notifications.js",
        sha256: "dadb7f1fca2f8972da38f60b3176da850236d499b8e07d9416e42808d854ce27",
      },
    ],
    resource: "/local/community/origami-notifications/origami-notifications.js",
  },
  {
    key: "origami-weather",
    label: "Origami Weather",
    repo: "hazymorning/origami_weather",
    tag: "V1.6.1",
    kind: "plugin",
    files: [
      {
        from: "dist/origami-weather.js",
        to: "origami-weather.js",
        sha256: "f2342d9f7406d01c6a3942fe553424c30d138c09018325f51046f701b0a21f1a",
      },
    ],
    resource: "/local/community/origami-weather/origami-weather.js",
  },
  {
    key: "navbar-card",
    label: "Navbar Card",
    repo: "joseluis9595/lovelace-navbar-card",
    tag: "v1.8.0",
    kind: "plugin",
    files: [
      {
        from: "navbar-card.js",
        to: "navbar-card.js",
        sha256: "df71d839dfdd1c279c6b4e190aae1b3b756c8eaf3b2d8a1c601c60d97ecf9882",
      },
    ],
    resource: "/local/community/navbar-card/navbar-card.js",
  },
];

export const PLUGIN_KEYS = PLUGINS.map((plugin) => plugin.key);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function verifyFile(file, expected) {
  if (!expected) return true;
  try {
    return sha256(fs.readFileSync(file)) === expected;
  } catch {
    return false;
  }
}

async function download(url, destination, expected) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 200) throw new Error(`Suspiciously small download (${buffer.length} B): ${url}`);
  if (expected && sha256(buffer) !== expected) {
    throw new Error(`SHA-256 mismatch for ${url} (expected ${expected}).`);
  }
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

async function fetchPluginFile(plugin, file) {
  const cached = path.join(CACHE_DIR, `${plugin.key}-${plugin.tag}-${path.basename(file.to)}`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) {
    if (verifyFile(cached, file.sha256)) return cached;
    fs.rmSync(cached, { force: true });
  }

  const attempts = [
    `https://cdn.jsdelivr.net/gh/${plugin.repo}@${plugin.tag}/${file.from}`,
    `https://raw.githubusercontent.com/${plugin.repo}/${plugin.tag}/${file.from}`,
    `https://github.com/${plugin.repo}/releases/download/${plugin.tag}/${path.basename(file.to)}`,
  ];

  let lastError = null;
  for (const url of attempts) {
    try {
      await download(url, cached, file.sha256);
      return cached;
    } catch (error) {
      lastError = error;
    }
  }

  // Last resort: the tagged source tarball (useful when only release assets exist).
  const tarball = path.join(CACHE_DIR, `${plugin.key}-${plugin.tag}.tar.gz`);
  try {
    if (!fs.existsSync(tarball)) {
      await download(`https://codeload.github.com/${plugin.repo}/tar.gz/refs/tags/${plugin.tag}`, tarball);
    }
    const tmp = fs.mkdtempSync(path.join(CACHE_DIR, `${plugin.key}-`));
    try {
      await exec("tar", ["xzf", tarball, "-C", tmp]);
      const root = fs.readdirSync(tmp).find((entry) => fs.statSync(path.join(tmp, entry)).isDirectory());
      const source = path.join(tmp, root, file.from);
      if (!fs.existsSync(source)) throw new Error(`${plugin.label}: ${file.from} not found in ${plugin.tag}`);
      if (!verifyFile(source, file.sha256)) {
        throw new Error(`${plugin.label}: SHA-256 mismatch after extracting ${plugin.tag}.`);
      }
      fs.copyFileSync(source, cached);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return cached;
  } catch (error) {
    const detail = lastError?.message || error.message;
    throw new Error(
      `${plugin.label} ${plugin.tag} konnte nicht verifiziert geladen werden: ${detail}. ` +
        "Netzwerk prüfen oder die Version in app/server/plugins.js aktualisieren.",
    );
  }
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
    if (fs.existsSync(tarball) && !verifyFile(tarball, plugin.sha256)) {
      fs.rmSync(tarball, { force: true });
    }
    if (!fs.existsSync(tarball)) {
      log(`Lade ${plugin.label} ${plugin.tag} …`);
      await download(
        `https://codeload.github.com/${plugin.repo}/tar.gz/refs/tags/${plugin.tag}`,
        tarball,
        plugin.sha256,
      );
    }
    const tmp = fs.mkdtempSync(path.join(CACHE_DIR, `${plugin.key}-`));
    try {
      await exec("tar", ["xzf", tarball, "-C", tmp]);
      const root = fs.readdirSync(tmp).find((entry) => fs.statSync(path.join(tmp, entry)).isDirectory());
      const source = path.join(tmp, root, "custom_components", plugin.folder);
      if (!fs.existsSync(source)) throw new Error(`${plugin.label}: custom_components/${plugin.folder} missing`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
