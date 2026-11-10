import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CACHE_DIR, ORIGAMI_REPO, ORIGAMI_TAG, VENDOR_DIR } from "./config.js";

const exec = promisify(execFile);

export const TAG = ORIGAMI_TAG;

export function vendorPath(tag = TAG) {
  return path.join(VENDOR_DIR, `origami-${tag}`);
}

export function isSynced(tag = TAG) {
  const dir = vendorPath(tag);
  return (
    fs.existsSync(path.join(dir, "themes", "origami.yaml")) &&
    fs.existsSync(path.join(dir, "dashboard", "greeting", "card.yaml")) &&
    fs.existsSync(path.join(dir, "bubble_card", "modules", "origami_base.yaml"))
  );
}

export function readPart(relative, tag = TAG) {
  const file = path.join(vendorPath(tag), relative);
  if (!fs.existsSync(file)) throw new Error(`Origami file missing: ${relative}`);
  return fs.readFileSync(file, "utf8");
}

export async function syncVendor(log = () => {}, tag = TAG) {
  if (isSynced(tag)) return vendorPath(tag);

  const tarball = path.join(CACHE_DIR, `origami-${tag}.tar.gz`);
  if (!fs.existsSync(tarball)) {
    const urls = [
      `https://codeload.github.com/${ORIGAMI_REPO}/tar.gz/refs/tags/${tag}`,
      `https://codeload.github.com/${ORIGAMI_REPO}/tar.gz/refs/heads/main`,
    ];
    let ok = false;
    for (const url of urls) {
      try {
        log(`Lade Origami (${tag}) …`);
        const response = await fetch(url, { redirect: "follow" });
        if (!response.ok) throw new Error(String(response.status));
        fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
        ok = true;
        break;
      } catch (error) {
        log(`Download fehlgeschlagen: ${error.message}`, "warn");
      }
    }
    if (!ok) throw new Error("Origami konnte nicht geladen werden. Internetverbindung prüfen.");
  }

  const tmp = fs.mkdtempSync(path.join(CACHE_DIR, "origami-extract-"));
  await exec("tar", ["xzf", tarball, "-C", tmp]);
  const root = fs.readdirSync(tmp).find((entry) => fs.statSync(path.join(tmp, entry)).isDirectory());
  if (!root) throw new Error("Origami archive is empty.");
  const target = vendorPath(tag);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(tmp, root), target);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(target, ".origami-lxc"), `${tag}\n`);
  log(`Origami ${tag} bereitgestellt.`);
  return target;
}

export function listModules() {
  const dir = path.join(vendorPath(), "bubble_card", "modules");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".yaml"));
}
