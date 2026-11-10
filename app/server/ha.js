import { APP_VERSION } from "./config.js";

export class HAError extends Error {
  constructor(message, status = 0, body = "") {
    super(message);
    this.name = "HAError";
    this.status = status;
    this.body = body;
  }
}

export function normalizeUrl(input) {
  let url = String(input || "").trim();
  if (!url) throw new HAError("Home Assistant URL is empty.");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HAError(`Invalid Home Assistant URL: ${input}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HAError("Only http:// and https:// URLs are supported.");
  }
  return url;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HA {
  constructor(url, token) {
    this.url = normalizeUrl(url);
    this.token = token;
    this.ws = null;
    this.wsReady = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async rest(pathname, { method = "GET", body, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.url}${pathname}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new HAError(
          `Home Assistant answered ${response.status} for ${pathname}`,
          response.status,
          text.slice(0, 500),
        );
      }
      if (!text) return null;
      const type = response.headers.get("content-type") || "";
      return type.includes("application/json") ? JSON.parse(text) : text;
    } catch (error) {
      if (error.name === "AbortError") throw new HAError(`Timeout while calling ${pathname}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async open() {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.wsReady) return this.wsReady;

    this.wsReady = new Promise((resolve, reject) => {
      const wsUrl = `${this.url.replace(/^http/i, "ws")}/api/websocket`;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      let authed = false;

      const fail = (error) => {
        this.wsReady = null;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(error);
      };

      const timer = setTimeout(() => fail(new HAError("WebSocket handshake timed out")), 15000);

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
          return;
        }
        if (message.type === "auth_ok") {
          authed = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (message.type === "auth_invalid") {
          clearTimeout(timer);
          fail(new HAError("Home Assistant rejected the token."));
          return;
        }
        if (message.type === "result" && message.id) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.success) entry.resolve(message.result);
          else entry.reject(new HAError(message.error?.message || "WebSocket command failed"));
        }
      });

      socket.addEventListener("error", () => {
        if (!authed) {
          clearTimeout(timer);
          fail(new HAError(`Could not open a WebSocket to ${this.url}`));
        }
      });

      socket.addEventListener("close", () => {
        this.wsReady = null;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new HAError("WebSocket closed"));
        }
        this.pending.clear();
        if (!authed) {
          clearTimeout(timer);
          reject(new HAError("WebSocket closed before authentication"));
        }
      });
    });

    return this.wsReady;
  }

  async call(type, payload = {}, timeout = 25000) {
    await this.open();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HAError(`WebSocket command ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, type, ...payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HAError(`Could not send ${type}: ${error.message}`));
      }
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.wsReady = null;
  }

  async ping() {
    const [config, states] = await Promise.all([this.rest("/api/config"), this.rest("/api/states")]);
    return {
      url: this.url,
      version: config.version,
      locationName: config.location_name,
      timeZone: config.time_zone,
      unitSystem: config.unit_system,
      stateCount: Array.isArray(states) ? states.length : 0,
      components: config.components || [],
    };
  }

  async states() {
    return (await this.rest("/api/states")) || [];
  }

  async registries() {
    const safe = (type) => this.call(type).catch(() => []);
    const [areas, devices, entities, floors] = await Promise.all([
      safe("config/area_registry/list"),
      safe("config/device_registry/list"),
      safe("config/entity_registry/list"),
      safe("config/floor_registry/list"),
    ]);
    return { areas: areas || [], devices: devices || [], entities: entities || [], floors: floors || [] };
  }

  async dashboards() {
    return (await this.call("lovelace/dashboards/list")) || [];
  }

  async createDashboard({ url_path, title, icon, show_in_sidebar = true }) {
    return this.call("lovelace/dashboards/create", {
      url_path,
      title,
      icon,
      show_in_sidebar,
      require_admin: false,
      mode: "storage",
    });
  }

  async deleteDashboard(dashboard_id) {
    return this.call("lovelace/dashboards/delete", { dashboard_id });
  }

  async saveDashboard(url_path, config) {
    return this.call("lovelace/config/save", { url_path, config });
  }

  async getDashboard(url_path) {
    return this.call("lovelace/config", { url_path });
  }

  async resources() {
    return (await this.call("lovelace/resources/list")) || [];
  }

  async createResource(url, res_type = "module") {
    return this.call("lovelace/resources/create", { url, res_type });
  }

  async deleteResource(resource_id) {
    return this.call("lovelace/resources/delete", { resource_id });
  }

  async createHelper(domain, data) {
    return this.call(`${domain}/create`, data);
  }

  async deleteHelper(domain, helper_id) {
    return this.call(`${domain}/delete`, { [`${domain}_id`]: helper_id });
  }

  async createScript(objectId, config) {
    return this.rest(`/api/config/script/config/${objectId}`, { method: "POST", body: config });
  }

  async restart() {
    return this.rest("/api/services/homeassistant/restart", { method: "POST", body: {} });
  }

  async waitUntilReady(timeoutMs = 180000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      try {
        await this.rest("/api/", { timeout: 4000 });
        return true;
      } catch {
        /* keep waiting */
      }
    }
    return false;
  }

  async agentInfo() {
    return {
      name: `origami-lxc/${APP_VERSION}`,
      version: APP_VERSION,
    };
  }
}
