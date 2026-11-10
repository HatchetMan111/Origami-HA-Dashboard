import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_VERSION = "0.1.0";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
export const HA_CONFIG = path.resolve(process.env.HA_CONFIG || "/ha-config");
export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || "0.0.0.0";

export const ORIGAMI_REPO = process.env.ORIGAMI_REPO || "hazymorning/origami";
export const ORIGAMI_TAG = process.env.ORIGAMI_TAG || "V3.0";

export const VENDOR_DIR = path.join(DATA_DIR, "vendor");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const KEY_FILE = path.join(DATA_DIR, "secret.key");

export const DASHBOARD_URL_PATH = "origami-dashboard";
export const DASHBOARD_TITLE = "Origami";
export const DASHBOARD_ICON = "mdi:origami";

export const PUBLIC_DIR = fileURLToPath(new URL("../web/", import.meta.url));

for (const dir of [DATA_DIR, VENDOR_DIR, CACHE_DIR, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
