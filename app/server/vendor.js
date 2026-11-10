import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CACHE_DIR, ORIGAMI_REPO, ORIGAMI_SHA256, ORIGAMI_TAG, VENDOR_DIR } from "./config.js";

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
  if (ORIGAMI_SHA256 && fs.existsSync(tarball)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    if (actual !== ORIGAMI_SHA256) fs.rmSync(tarball, { force: true });
  }
  if (!fs.existsSync(tarball)) {
    const url = `https://codeload.github.com/${ORIGAMI_REPO}/tar.gz/refs/tags/${tag}`;
    log(`Lade Origami (${tag}) …`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `Origami ${tag} konnte nicht geladen werden (${response.status}). ` +
          "Internetverbindung prüfen oder den Tag in app/server/config.js anpassen.",
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!ORIGAMI_SHA256) {
      log("Warnung: kein SHA-256 für diesen Origami-Tag hinterlegt (ORIGAMI_SHA256).", "warn");
    } else if (crypto.createHash("sha256").update(buffer).digest("hex") !== ORIGAMI_SHA256) {
      throw new Error(
        `SHA-256 des Origami-Archivs stimmt nicht (Tag ${tag}). ` +
          "Der Download wurde abgebrochen – nichts wurde installiert.",
      );
    }
    fs.writeFileSync(tarball, buffer);
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
