import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { APP_VERSION, BACKUP_DIR, DASHBOARD_TITLE, HOST, PORT } from "./config.js";
import { configAccess, applyAll, buildBundle, installedPlugins, rollback, verify } from "./apply.js";
import { discover } from "./discover.js";
import { buildDashboard } from "./generate.js";
import { HA, HAError, normalizeUrl } from "./ha.js";
import { json, parseCookies, readJson, serveStatic } from "./http.js";
import { getJob, publicJob, startJob, subscribe } from "./jobs.js";
import { PLUGINS } from "./plugins.js";
import {
  appendHistory,
  checkSession,
  decrypt,
  encrypt,
  issueSession,
  patchState,
  readState,
  setupCode,
  verifySetupCode,
} from "./store.js";
import { isSynced, syncVendor, TAG } from "./vendor.js";

const DEFAULT_OPTIONS = {
  greeting: true,
  notifications: true,
  weather: true,
  localAssets: true,
  rooms: true,
  climateTable: true,
  allRooms: true,
  menu: false,
  lightsPopup: true,
  navigationBar: true,
  roomPopups: false,
  favorites: false,
  musicPopup: false,
  tvPopup: false,
  fanPopup: false,
  vacuumPopup: false,
  serverPopup: false,
};

const loginFailures = new Map();

function clientIp(request) {
  return request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket.remoteAddress || "?";
}

function sessionCookie(token) {
  return `origami_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`;
}

function requireAuth(request, response) {
  const cookies = parseCookies(request);
  if (checkSession(cookies.origami_session)) return true;
  json(response, 401, { error: "Nicht angemeldet.", code: "AUTH" });
  return false;
}

function stateForClient() {
  const state = readState();
  return {
    appVersion: APP_VERSION,
    authDisabled: process.env.DISABLE_AUTH === "1",
    connected: state.connected,
    mapping: state.mapping,
    options: state.options || DEFAULT_OPTIONS,
    created: state.created,
    lastApply: state.lastApply,
    vendor: state.vendor,
    history: (state.history || []).slice(-10),
    access: configAccess(),
    installed: installedPlugins(),
  };
}

function haClient() {
  const state = readState();
  if (!state.connected?.url) throw new HAError("Noch keine Verbindung zu Home Assistant.");
  const token = decrypt(state.tokenEnc);
  if (!token) throw new HAError("Token konnte nicht entschlüsselt werden. Bitte neu verbinden.");
  return new HA(state.connected.url, token);
}

async function withHA(fn) {
  const ha = haClient();
  try {
    return await fn(ha);
  } finally {
    ha.close();
  }
}

function sanitizeMapping(input) {
  const entity = (value) => (typeof value === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(value) ? value : "");
  const list = (value, max = 100) =>
    Array.isArray(value) ? [...new Set(value.map(entity).filter(Boolean))].slice(0, max) : [];

  const rooms = (Array.isArray(input?.rooms) ? input.rooms : []).slice(0, 30).map((room, index) => ({
    key:
      String(room.key || `room_${index + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || `room_${index + 1}`,
    name: String(room.name || `Raum ${index + 1}`).slice(0, 60),
    icon: typeof room.icon === "string" && room.icon.startsWith("mdi:") ? room.icon : "mdi:home",
    light: entity(room.light),
    lights: list(room.lights),
    temperature: entity(room.temperature),
    humidity: entity(room.humidity),
    window: entity(room.window),
    climate: entity(room.climate),
    media: entity(room.media),
    cover: entity(room.cover),
    fan: entity(room.fan),
  }));

  const seen = new Set();
  for (const room of rooms) {
    let key = room.key;
    let suffix = 2;
    while (seen.has(key)) key = `${room.key}_${suffix++}`;
    room.key = key;
    seen.add(key);
  }

  const global = input?.global || {};
  return {
    rooms,
    global: {
      weather: entity(global.weather),
      calendar: entity(global.calendar),
      vacuum: entity(global.vacuum),
      tv: entity(global.tv),
      speakers: list(global.speakers, 20),
      lights: list(global.lights, 80),
      groupLight: entity(global.groupLight),
      scenes: list(global.scenes, 30),
      todos: list(global.todos, 20),
      persons: list(global.persons, 20),
      temperatureUnit: global.temperatureUnit === "°F" ? "°F" : "°C",
    },
  };
}

function sanitizeOptions(input) {
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (typeof input?.[key] === "boolean") out[key] = input[key];
  }
  return out;
}

function buildFromState() {
  const state = readState();
  if (!state.mapping) throw new Error("Noch keine Zuordnung gespeichert.");
  const options = state.options || DEFAULT_OPTIONS;
  return buildDashboard(state.mapping, options, {
    knownEntities: state.discovered?.knownEntities || [],
    states: state.discovered?.states || [],
  });
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route("GET", /^\/api\/health$/, async (_request, response) => {
  json(response, 200, {
    ok: true,
    app: "origami-lxc",
    version: APP_VERSION,
    origamiTag: TAG,
    vendor: isSynced(),
    host: os.hostname(),
  });
});

route("POST", /^\/api\/login$/, async (request, response) => {
  const ip = clientIp(request);
  const failures = loginFailures.get(ip) || { count: 0, until: 0 };
  if (failures.until > Date.now()) {
    json(response, 429, { error: "Zu viele Versuche. Bitte kurz warten." });
    return;
  }
  const body = await readJson(request);
  if (!verifySetupCode(body.code)) {
    failures.count += 1;
    if (failures.count >= 10) {
      failures.until = Date.now() + 10 * 60 * 1000;
      failures.count = 0;
    }
    loginFailures.set(ip, failures);
    json(response, 401, { error: "Setup-Code stimmt nicht." });
    return;
  }
  loginFailures.delete(ip);
  response.setHeader("Set-Cookie", sessionCookie(issueSession()));
  json(response, 200, { ok: true, ...stateForClient() });
});

route("POST", /^\/api\/logout$/, async (_request, response) => {
  response.setHeader("Set-Cookie", "origami_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  json(response, 200, { ok: true });
});

route("GET", /^\/api\/session$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  json(response, 200, { authenticated: true, ...stateForClient() });
});

route("POST", /^\/api\/connect$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const body = await readJson(request);
  const url = normalizeUrl(body.url);
  const token = String(body.token || "").trim();
  if (!token) {
    json(response, 400, { error: "Long-Lived Access Token fehlt." });
    return;
  }
  const ha = new HA(url, token);
  try {
    const info = await ha.ping();
    const registries = await ha.registries();
    patchState({
      connected: { url, version: info.version, locationName: info.locationName, unitSystem: info.unitSystem },
      tokenEnc: encrypt(token),
      mapping: null,
      options: { ...DEFAULT_OPTIONS, ...(readState().options || {}) },
      created: null,
      discovered: { knownEntities: [], states: [] },
    });
    json(response, 200, {
      ok: true,
      ha: info,
      registries: {
        areas: registries.areas.length,
        devices: registries.devices.length,
        entities: registries.entities.length,
      },
      access: configAccess(),
      installed: installedPlugins(),
    });
  } catch (error) {
    const message =
      error instanceof HAError && error.status === 401
        ? "Home Assistant hat den Token abgelehnt (401). Bitte einen neuen Long-Lived Token erzeugen."
        : error.message;
    json(response, 400, { error: message });
  } finally {
    ha.close();
  }
});

route("GET", /^\/api\/discover$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const ha = haClient();
  try {
    const [states, config, registries] = await Promise.all([ha.states(), ha.rest("/api/config"), ha.registries()]);
    const result = discover({ states, registries, config });
    const names = {};
    const compact = [];
    const areaByEntity = new Map((registries.entities || []).map((row) => [row.entity_id, row.area_id || ""]));
    for (const state of states) {
      names[state.entity_id] = state.attributes?.friendly_name || state.entity_id;
      compact.push({
        id: state.entity_id,
        name: state.attributes?.friendly_name || state.entity_id,
        domain: state.entity_id.split(".")[0],
        area: areaByEntity.get(state.entity_id) || "",
        deviceClass: state.attributes?.device_class || "",
      });
    }
    const previous = readState();
    const mapping = previous.mapping || { rooms: result.rooms, global: result.global };
    patchState({
      discovered: {
        knownEntities: result.knownEntities,
        names,
        states: states.map((state) => ({
          entity_id: state.entity_id,
          state: state.state,
          attributes: {
            friendly_name: state.attributes?.friendly_name,
            device_class: state.attributes?.device_class,
            unit_of_measurement: state.attributes?.unit_of_measurement,
            entity_id: state.attributes?.entity_id,
          },
        })),
      },
      mapping,
    });
    json(response, 200, {
      ok: true,
      suggestions: { rooms: result.rooms, global: result.global },
      counts: result.counts,
      warnings: result.warnings,
      areas: registries.areas,
      entities: compact,
      mapping,
      access: configAccess(),
      installed: installedPlugins(),
    });
  } finally {
    ha.close();
  }
});

route("POST", /^\/api\/mapping$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const body = await readJson(request);
  const mapping = sanitizeMapping(body.mapping);
  const options = sanitizeOptions(body.options);
  patchState({ mapping, options });
  json(response, 200, { ok: true, mapping, options });
});

route("POST", /^\/api\/plan$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  if (!isSynced()) await syncVendor((message) => console.log(`[vendor] ${message}`));
  const dashboard = buildFromState();
  const state = readState();
  const pluginKeys = PLUGINS.filter((plugin) => {
    if (plugin.key === "origami-header") return Boolean(state.options?.menu);
    if (plugin.key === "origami-notifications") return Boolean(state.options?.notifications);
    if (plugin.key === "origami-weather") return Boolean(state.options?.weather);
    if (plugin.key === "navbar-card") return Boolean(state.options?.navigationBar);
    return true;
  }).map((plugin) => plugin.key);

  patchState({ lastPlan: { at: Date.now(), stats: dashboard.stats, urlPath: dashboard.urlPath } });
  json(response, 200, {
    ok: true,
    dashboard: {
      title: dashboard.title,
      urlPath: dashboard.urlPath,
      stats: dashboard.stats,
      helpers: dashboard.helpers,
      missingEntities: dashboard.missingEntities,
    },
    plugins: pluginKeys,
    access: configAccess(),
    options: state.options,
  });
});

route("POST", /^\/api\/apply$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const state = readState();
  if (!state.mapping) {
    json(response, 400, { error: "Bitte zuerst die Entitäten zuordnen." });
    return;
  }
  const dashboard = buildFromState();
  const job = startJob("apply", async (log) => {
    const ha = haClient();
    try {
      const result = await applyAll({
        ha,
        dashboard,
        mapping: state.mapping,
        options: state.options,
        log,
      });
      const now = Date.now();
      patchState({ created: result.created, lastApply: { at: now, checks: result.checks, warnings: result.warnings } });
      appendHistory({ at: now, action: "apply", ok: result.checks.every((check) => check.ok) });
      return {
        created: result.created,
        checks: result.checks,
        warnings: result.warnings,
        restartRequired: result.restartRequired,
      };
    } finally {
      ha.close();
    }
  });
  json(response, 202, { job: publicJob(job) });
});

route("POST", /^\/api\/restart$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const job = startJob("restart", async (log) => {
    const ha = haClient();
    log("Home Assistant wird neu gestartet …");
    await ha.restart();
    ha.close();
    const probe = haClient();
    const ready = await probe.waitUntilReady(240000);
    probe.close();
    if (!ready) throw new Error("Home Assistant war nach 4 Minuten nicht wieder erreichbar.");
    log("Home Assistant ist wieder da.");
    return { ready: true };
  });
  json(response, 202, { job: publicJob(job) });
});

route("POST", /^\/api\/rollback$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const state = readState();
  if (!state.created) {
    json(response, 400, { error: "Keine Installation zum Zurücksetzen gefunden." });
    return;
  }
  const job = startJob("rollback", async (log) => {
    const notes = await rollback({ ha: haClient(), created: state.created, log });
    patchState({ created: null });
    appendHistory({ at: Date.now(), action: "rollback", ok: true });
    return { notes };
  });
  json(response, 202, { job: publicJob(job) });
});

route("POST", /^\/api\/verify$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const state = readState();
  if (!state.created) {
    json(response, 400, { error: "Noch nichts installiert." });
    return;
  }
  const dashboard = buildFromState();
  const checks = await withHA((ha) => verify(ha, dashboard, state.created));
  json(response, 200, { ok: true, checks });
});

route("GET", /^\/api\/job\/([a-f0-9]+)$/, async (request, response, params) => {
  if (!requireAuth(request, response)) return;
  const job = getJob(params[0]);
  if (!job) {
    json(response, 404, { error: "Job nicht gefunden." });
    return;
  }
  json(response, 200, { job: publicJob(job) });
});

route("GET", /^\/api\/job\/([a-f0-9]+)\/events$/, async (request, response, params) => {
  if (!requireAuth(request, response)) return;
  if (!subscribe(params[0], response)) json(response, 404, { error: "Job nicht gefunden." });
});

route("GET", /^\/api\/bundle$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const dashboard = buildFromState();
  const file = path.join(BACKUP_DIR, `origami-bundle-${Date.now()}.tar.gz`);
  await buildBundle(dashboard, readState().options, file);
  response.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": 'attachment; filename="origami-bundle.tar.gz"',
  });
  const stream = fs.createReadStream(file);
  stream.pipe(response);
  stream.on("close", () => fs.rm(file, { force: true }, () => {}));
});

route("GET", /^\/api\/plugins$/, async (request, response) => {
  if (!requireAuth(request, response)) return;
  const installed = new Set(installedPlugins());
  json(response, 200, {
    plugins: PLUGINS.map((plugin) => ({
      key: plugin.key,
      label: plugin.label,
      repo: plugin.repo,
      tag: plugin.tag,
      kind: plugin.kind,
      installed: installed.has(plugin.key),
    })),
  });
});

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");

  const url = new URL(request.url, "http://localhost");
  try {
    for (const entry of routes) {
      if (entry.method !== request.method) continue;
      const match = entry.pattern.exec(url.pathname);
      if (!match) continue;
      await entry.handler(request, response, match.slice(1));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "Unbekannter API-Endpunkt." });
      return;
    }
    if (!serveStatic(request, response)) {
      json(response, 404, { error: "Nicht gefunden." });
    }
  } catch (error) {
    console.error(error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    json(response, error.status || 500, { error: error.message || "Interner Fehler." });
  }
});

server.listen(PORT, HOST, () => {
  const code = setupCode();
  console.log(`origami-lxc ${APP_VERSION}`);
  console.log(`  UI:        http://${HOST}:${PORT}`);
  console.log(`  HA config: ${configAccess().path} (${configAccess().writable ? "schreibbar" : "nicht schreibbar"})`);
  if (code !== "disabled") console.log(`  Setup-Code: ${code}`);
  else console.log("  AUTH DISABLED (DISABLE_AUTH=1)");
});
