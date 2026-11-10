import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, KEY_FILE, STATE_FILE } from "./config.js";

const EMPTY = {
  connected: null,
  tokenEnc: null,
  mapping: null,
  options: null,
  created: null,
  vendor: null,
  lastApply: null,
  history: [],
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function readState() {
  return { ...structuredClone(EMPTY), ...readJson(STATE_FILE, EMPTY) };
}

export function writeState(next) {
  writeJson(STATE_FILE, next);
  return next;
}

export function patchState(patch) {
  const state = readState();
  return writeState({ ...state, ...patch });
}

export function appendHistory(entry) {
  const state = readState();
  state.history = [...(state.history || []), entry].slice(-50);
  writeState(state);
}

function key() {
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) return raw;
  } catch {
    /* create below */
  }
  const raw = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, raw, { mode: 0o600 });
  return raw;
}

export function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload) {
  if (!payload) return null;
  try {
    const [version, iv, tag, data] = String(payload).split(".");
    if (version !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function setupCode() {
  if (process.env.DISABLE_AUTH === "1") return "disabled";
  const candidates = [path.join(DATA_DIR, "setup-code"), path.join(DATA_DIR, "..", "setup-code")];
  for (const file of candidates) {
    try {
      const code = fs.readFileSync(file, "utf8").trim();
      if (code) return code;
    } catch {
      /* next */
    }
  }
  const code = crypto.randomBytes(6).toString("hex").toUpperCase();
  fs.writeFileSync(candidates[0], `${code}\n`, { mode: 0o600 });
  return code;
}

function hmac(value) {
  return crypto.createHmac("sha256", setupCode()).update(value).digest("base64url");
}

export function issueSession(ttlMs = 12 * 60 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const payload = `v1.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

export function checkSession(cookie) {
  if (process.env.DISABLE_AUTH === "1") return true;
  if (!cookie || typeof cookie !== "string") return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = hmac(payload);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function verifySetupCode(input) {
  const code = setupCode();
  if (code === "disabled") return true;
  if (typeof input !== "string") return false;
  const given = crypto.createHash("sha256").update(input.trim().toUpperCase()).digest();
  const expected = crypto.createHash("sha256").update(code.toUpperCase()).digest();
  return crypto.timingSafeEqual(given, expected);
}
