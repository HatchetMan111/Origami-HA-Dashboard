const $ = (selector, root = document) => root.querySelector(selector);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const S = {
  view: "loading",
  session: null,
  entities: [],
  areas: [],
  mapping: { rooms: [], global: {} },
  options: {},
  access: null,
  plan: null,
  job: null,
  checks: [],
  warnings: [],
  error: "",
  connected: false,
  busy: false,
};

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
};

const OPTION_LABELS = {
  greeting: ["Begrüßung", "Gruß, nächstes Kalender-Ereignis und Benachrichtigungen."],
  notifications: ["Benachrichtigungen", "Origami-Notifications-Karte (Plugin)."],
  weather: ["Wetter", "Papier-Haus mit Wetter und Raumtemperaturen."],
  localAssets: ["Assets lokal", "Wetterbilder aus dem Container statt von jsDelivr."],
  rooms: ["Räume", "Eine Karte pro Raum mit Temperatur, Licht und Fenster."],
  climateTable: ["Klima-Tabelle", "Alle Räume nebeneinander, ein-/ausklappbar."],
  allRooms: ["„Alle Räume“", "Ausgeblendete Räume per Schalter zeigen."],
  menu: ["Menü", "Origami-Header mit ausfahrbarem Menü (versteckt HA-Kopfzeile)."],
  lightsPopup: ["Lichter-Pop-up", "Slider für alle Lampen, ohne Szenen."],
  navigationBar: ["Navigationsleiste", "Navbar Card unten mit Lichtern und Menü."],
};

async function api(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function absorb(session) {
  S.session = session;
  S.connected = Boolean(session.connected);
  S.access = session.access || S.access;
  S.options = { ...DEFAULT_OPTIONS, ...(session.options || {}) };
  if (session.mapping) S.mapping = session.mapping;
  if (!S.mapping.rooms) S.mapping.rooms = [];
  if (!S.mapping.global) S.mapping.global = {};
}

function toast(message, bad = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (element.className = "toast"), 3600);
}

function accessBanner() {
  const access = S.access;
  if (!access) return "";
  if (access.writable && access.valid) {
    return `<div class="banner ok"><strong>Schreibzugriff auf /config</strong>Theme, Fonts, Module und Plugins werden direkt installiert.</div>`;
  }
  return `<div class="banner warn">
    <strong>Kein Schreibzugriff auf Home Assistants /config</strong>
    Ohne diesen Zugriff lassen sich Theme, Fonts und Plugins nicht installieren. Binde den Ordner auf dem Proxmox-Host ein:
    <div class="mt"><code class="inline">bash install/ha-mount.sh --ctid &lt;CTID&gt; --smb '//&lt;HA-IP&gt;/config' --user &lt;user&gt; --pass '&lt;pass&gt;'</code></div>
    <div class="mt small">HAOS: „Samba share“-Add-on aktivieren. Danach hier <b>Zugriff prüfen</b>.</div>
    <div class="row mt"><button class="small" data-action="recheck">Zugriff prüfen</button></div>
  </div>`;
}

function statusChip() {
  if (!S.connected) return `<span class="chip">nicht verbunden</span>`;
  const info = S.session?.connected || {};
  const access = S.access?.writable && S.access?.valid;
  return `<span class="chip ok"><span class="dot"></span>${esc(info.locationName || "Home Assistant")} ${esc(info.version || "")}</span>
    <span class="chip ${access ? "ok" : "warn"}">${access ? "Schreibzugriff" : "nur Lesen"}</span>`;
}

function renderStepper() {
  const steps = [
    ["Verbinden", ["connect", "auth"]],
    ["Zuordnen", ["map"]],
    ["Installieren", ["plan", "apply"]],
  ];
  const activeIndex = steps.findIndex(([, views]) => views.includes(S.view));
  $("#stepper").innerHTML = steps
    .map(([label], index) => {
      const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "";
      return `<div class="step ${state}"><span class="num">${index + 1}</span>${label}</div>`;
    })
    .join("");
}

function render() {
  $("#status").innerHTML = statusChip();
  renderStepper();
  const app = $("#app");
  if (S.view === "loading") app.innerHTML = `<div class="card"><p class="muted">Lade …</p></div>`;
  else if (S.view === "auth") app.innerHTML = authView();
  else if (S.view === "connect") app.innerHTML = connectView();
  else if (S.view === "map") app.innerHTML = mapView();
  else if (S.view === "plan") app.innerHTML = planView();
  else if (S.view === "apply") app.innerHTML = applyView();
  else if (S.view === "error") app.innerHTML = errorView();
}

function authView() {
  return `<section class="card auth">
    <h2>Setup-Code</h2>
    <p class="sub">Der Code steht auf dem Proxmox-Host. Im Container:
      <code class="inline">cat /opt/origami/setup-code</code></p>
    <form data-form="login">
      <label class="field"><span>Setup-Code</span>
        <input type="text" name="code" autocomplete="one-time-code" autocapitalize="characters" placeholder="z. B. 7K3M9Q2A" required />
      </label>
      <div class="row mt"><button class="primary" type="submit">Entsperren</button></div>
    </form>
  </section>`;
}

function connectView() {
  const info = S.session?.connected;
  return `${info ? `<section class="card">
      <div class="row between">
        <div>
          <h2 style="margin:0">Verbunden mit ${esc(info.locationName || "Home Assistant")}</h2>
          <p class="sub" style="margin:4px 0 0">${esc(info.url)} · Version ${esc(info.version || "?")}</p>
        </div>
        <button class="small ghost" data-action="reconnect">Neu verbinden</button>
      </div>
      ${accessBanner()}
      <div class="row"><button class="primary" data-action="discover">Entitäten laden</button></div>
    </section>` : ""}
    <section class="card">
      <h2>${info ? "Anderen Server verbinden" : "Mit Home Assistant verbinden"}</h2>
      <p class="sub">Die Adresse deiner lokalen Instanz und ein Long-Lived Access Token.
        Token erzeugen: Home Assistant → Profil → Sicherheit → Long-Lived Access Tokens.</p>
      <form data-form="connect">
        <div class="grid two">
          <label class="field"><span>Home Assistant URL</span>
            <input type="url" name="url" placeholder="http://192.168.1.10:8123" value="${esc(info?.url || "")}" required />
          </label>
          <label class="field"><span>Long-Lived Access Token</span>
            <input type="password" name="token" placeholder="eyJ0eXAiOiJKV1Qi…" autocomplete="off" required />
          </label>
        </div>
        <div class="row mt">
          <button class="primary" type="submit">Verbinden</button>
          <span class="hint">Das Token wird verschlüsselt gespeichert und nur für die Installation benutzt.</span>
        </div>
      </form>
    </section>`;
}

function entityOptions(domains, value, extraFilter) {
  let list = S.entities.filter((entity) => domains.includes(entity.domain));
  if (extraFilter) list = list.filter(extraFilter);
  if (value && !list.some((entity) => entity.id === value)) {
    list = [{ id: value, name: value, domain: value.split(".")[0] }, ...list];
  }
  const options = [`<option value="">— nicht nutzen —</option>`];
  for (const entity of list) {
    const label = `${entity.name}${entity.name === entity.id ? "" : ` · ${entity.id}`}`;
    options.push(`<option value="${esc(entity.id)}" ${entity.id === value ? "selected" : ""}>${esc(label.slice(0, 82))}</option>`);
  }
  return options.join("");
}

function field(label, value, domains, attrs, filter) {
  return `<label class="field"><span>${esc(label)}</span>
    <select ${attrs}>${entityOptions(domains, value || "", filter)}</select>
  </label>`;
}

function mapView() {
  const rooms = S.mapping.rooms || [];
  const global = S.mapping.global || {};

  const roomBlocks = rooms
    .map((room, index) => {
      const base = `data-kind="room" data-index="${index}"`;
      return `<div class="room">
        <div class="room-head">
          <div class="icon">${room.icon ? "◈" : "⌂"}</div>
          <input class="name" data-kind="room-name" data-index="${index}" value="${esc(room.name || `Raum ${index + 1}`)}" aria-label="Raumname" />
          <div class="push"></div>
          <button class="small ghost danger" data-action="remove-room" data-index="${index}">Entfernen</button>
        </div>
        <div class="grid two">
          ${field("Licht", room.light, ["light"], `${base} data-field="light"`)}
          ${field("Temperatur", room.temperature, ["sensor"], `${base} data-field="temperature"`, (e) => /temp|°c|°f/i.test(`${e.name} ${e.id}`) || e.deviceClass === "temperature")}
          ${field("Luftfeuchte", room.humidity, ["sensor"], `${base} data-field="humidity"`, (e) => /humid|feucht|%/.test(`${e.name} ${e.id}`) || e.deviceClass === "humidity")}
          ${field("Fenster/Tür", room.window, ["binary_sensor"], `${base} data-field="window"`, (e) => /fenster|window|tür|door|opening/.test(`${e.name} ${e.id}`) || ["window", "door", "opening"].includes(e.deviceClass))}
          ${field("Thermostat", room.climate, ["climate"], `${base} data-field="climate"`)}
          ${field("Mediaplayer", room.media, ["media_player"], `${base} data-field="media"`)}
          ${field("Rollladen", room.cover, ["cover"], `${base} data-field="cover"`)}
          ${field("Ventilator", room.fan, ["fan"], `${base} data-field="fan"`)}
        </div>
      </div>`;
    })
    .join("");

  const switches = Object.entries(OPTION_LABELS)
    .map(([key, [label, description]]) => {
      const checked = S.options[key] ? "checked" : "";
      return `<label class="switch"><input type="checkbox" data-kind="option" data-field="${key}" ${checked} />
        <span><b>${esc(label)}</b><small>${esc(description)}</small></span></label>`;
    })
    .join("");

  return `<section class="card">
      <div class="row between">
        <div><h2>Allgemein</h2><p class="sub" style="margin-bottom:0">Die Geräte, die es nur einmal gibt.</p></div>
      </div>
      <div class="grid two mt">
        ${field("Wetter", global.weather, ["weather"], `data-kind="global" data-field="weather"`)}
        ${field("Kalender", global.calendar, ["calendar"], `data-kind="global" data-field="calendar"`)}
        ${field("Staubsauger", global.vacuum, ["vacuum"], `data-kind="global" data-field="vacuum"`)}
        ${field("TV", global.tv, ["media_player"], `data-kind="global" data-field="tv"`)}
        ${field("Lampen-Gruppe", global.groupLight, ["light"], `data-kind="global" data-field="groupLight"`)}
        ${field("Haupt-Lautsprecher", (global.speakers || [])[0] || "", ["media_player"], `data-kind="global" data-field="speaker"`)}
      </div>
    </section>

    <section class="card">
      <div class="row between">
        <div><h2>Räume</h2><p class="sub" style="margin-bottom:0">Vorschläge aus deinen Home-Assistant-Bereichen. Alles editierbar.</p></div>
        <button class="small" data-action="add-room">Raum hinzufügen</button>
      </div>
      <div class="mt">${roomBlocks || `<div class="banner warn">Keine Räume gefunden. Lege in Home Assistant Bereiche an oder füge hier einen Raum hinzu.</div>`}</div>
    </section>

    <section class="card">
      <h2>Bausteine</h2>
      <p class="sub">Was auf dem Dashboard landen soll. Pop-ups für Musik, TV, Sauger und Server folgen in v0.2.</p>
      <div class="switch-grid">${switches}</div>
    </section>

    <div class="row end">
      <button class="ghost" data-action="reconnect">Zurück</button>
      <button class="primary" data-action="plan">Weiter zur Prüfung</button>
    </div>`;
}

function planView() {
  const plan = S.plan;
  if (!plan) return "";
  const access = S.access || plan.access || {};
  const missing = plan.dashboard.missingEntities || [];
  const ok = access.writable && access.valid;

  return `<section class="card">
      <h2>Bereit zur Installation</h2>
      <p class="sub">Ein Lauf legt Theme, Fonts, Module, Plugins, Ressourcen, Helper und das Dashboard an. Vorher wird ein Backup gezogen.</p>
      <div class="kpis">
        <div class="kpi"><b>${plan.dashboard.stats.cards}</b><span>Karten</span></div>
        <div class="kpi"><b>${plan.dashboard.stats.rooms}</b><span>Räume</span></div>
        <div class="kpi"><b>${plan.plugins.length}</b><span>Plugins</span></div>
        <div class="kpi"><b>${missing.length}</b><span>offene Entitäten</span></div>
      </div>
      ${accessBanner()}
      ${missing.length ? `<details class="missing"><summary>${missing.length} Beispiel-Entitäten sind noch nicht zugeordnet</summary>
        <p class="hint">Diese IDs kommen aus Origamis Beispiel-Haus und existieren bei dir nicht. Sie lassen sich später im HA-Editor ersetzen; betroffene Karten bleiben sonst leer.</p>
        <div class="row" style="gap:6px">${missing.slice(0, 40).map((id) => `<code class="inline">${esc(id)}</code>`).join(" ")}</div>
      </details>` : `<div class="banner ok"><strong>Alle Entitäten vorhanden</strong>Es fehlen keine Beispiel-Entitäten.</div>`}
      <div class="row mt">
        <a class="button" href="/api/bundle">Bundle herunterladen (manuell)</a>
        <div class="push"></div>
        <button class="ghost" data-action="back-map">Zurück</button>
        <button class="primary" data-action="apply" ${ok ? "" : "disabled"}>Installieren</button>
      </div>
      ${ok ? "" : `<p class="hint">Installieren ist gesperrt, bis /config schreibbar ist. Das Bundle enthält alle Dateien und eine Anleitung.</p>`}
    </section>`;
}

function checksView(checks) {
  if (!checks?.length) return "";
  return `<section class="card"><h2>Prüfung</h2><div class="mt">${checks
    .map(
      (check) => `<div class="check"><div class="mark ${check.ok ? "ok" : "bad"}">${check.ok ? "✓" : "!"}</div>
        <div><b>${esc(check.name)}</b>${check.detail ? `<small>${esc(check.detail)}</small>` : ""}</div></div>`,
    )
    .join("")}</div></section>`;
}

function applyView() {
  const created = S.session?.created;
  const last = S.session?.lastApply;
  const logs = (S.job?.logs || []).map((entry) => `<div class="${entry.level}">${esc(entry.message)}</div>`).join("");
  const dashboardUrl = `${S.session?.connected?.url || ""}/lovelace/${S.plan?.dashboard?.urlPath || "origami"}`;
  const failed = S.job?.status === "error";

  return `<section class="card">
      <div class="row between">
        <div><h2>${S.job?.status === "running" ? "Installiere …" : failed ? "Fehlgeschlagen" : "Installation"}</h2>
        <p class="sub" style="margin:4px 0 0">${failed ? esc(S.job?.error || "") : "Bitte diese Seite offen lassen."}</p></div>
        ${S.job?.status === "running" ? `<span class="chip warn"><span class="dot"></span>läuft</span>` : ""}
      </div>
      <div class="log mt" id="log">${logs}</div>
      <div class="row mt">
        ${S.job?.status === "running" ? "" : `<button class="ghost" data-action="reload">Status aktualisieren</button>`}
        <div class="push"></div>
        ${!S.job?.status || S.job.status === "done" ? `<button class="primary" data-action="open-dashboard" data-href="${esc(dashboardUrl)}">Dashboard öffnen</button>` : ""}
      </div>
    </section>

    ${checksView(S.checks)}

    ${created ? `<section class="card">
      <h2>Nächste Schritte</h2>
      <p class="sub">Home Assistant einmal neu starten, damit die Bubble-Card-Tools-Integration und das Theme sicher geladen sind.</p>
      <div class="row">
        <button class="primary" data-action="restart">Home Assistant neu starten</button>
        <button class="ghost" data-action="verify">Nur prüfen</button>
        <div class="push"></div>
        <button class="ghost danger" data-action="rollback">Zurücksetzen</button>
      </div>
      <div class="banner ok mt"><strong>Companion-App</strong>
        In der Home-Assistant-App diesen Server hinzufügen, dann unter Einstellungen → Dashboard „Origami“ als Startseite wählen.
        Direktlink: <a href="${esc(dashboardUrl)}" target="_blank" rel="noreferrer">${esc(dashboardUrl)}</a>
      </div>
    </section>` : ""}`;
}

function errorView() {
  return `<section class="card"><h2>Etwas ist schiefgelaufen</h2><p class="sub">${esc(S.error)}</p>
    <button class="primary" data-action="reload-page">Neu laden</button></section>`;
}

// ---------------------------------------------------------------- actions
async function boot() {
  try {
    const session = await api("/api/session");
    absorb(session);
    if (session.connected) {
      S.view = "connect";
      render();
      await discover(true);
    } else {
      S.view = "connect";
      render();
    }
  } catch (error) {
    if (error.status === 401) {
      S.view = "auth";
      render();
    } else {
      S.view = "error";
      S.error = error.message;
      render();
    }
  }
}

async function discover(silent = false) {
  if (!silent) toast("Lade Entitäten …");
  const data = await api("/api/discover");
  S.entities = data.entities || [];
  S.areas = data.areas || [];
  S.access = data.access;
  S.mapping = data.mapping || S.mapping;
  S.options = { ...S.options, ...(data.options || {}) };
  S.view = "map";
  render();
  if (data.warnings?.length) toast(data.warnings[0], true);
}

async function saveMapping() {
  await api("/api/mapping", { method: "POST", body: { mapping: S.mapping, options: S.options } });
}

async function makePlan() {
  await saveMapping();
  const plan = await api("/api/plan", { method: "POST", body: {} });
  S.plan = plan;
  S.access = plan.access || S.access;
  S.view = "plan";
  render();
}

function appendLog(entry) {
  if (!S.job) S.job = { logs: [] };
  S.job.logs.push(entry);
  const log = $("#log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = entry.level;
  line.textContent = entry.message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function streamJob(jobId, onDone) {
  const source = new EventSource(`/api/job/${jobId}/events`);
  source.onmessage = (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  };
  source.addEventListener("end", async (event) => {
    source.close();
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch {
      /* ignore */
    }
    S.job = { ...(S.job || {}), status: payload.status, result: payload.result, error: payload.error };
    if (onDone) await onDone(payload);
  });
  source.onerror = () => {
    source.close();
  };
}

async function startApply() {
  S.view = "apply";
  S.job = { status: "running", logs: [] };
  S.checks = [];
  render();
  const { job } = await api("/api/apply", { method: "POST", body: {} });
  streamJob(job.id, async (payload) => {
    const session = await api("/api/session");
    absorb(session);
    S.checks = payload.result?.checks || session.lastApply?.checks || [];
    if (payload.error) toast(payload.error, true);
    render();
  });
}

async function restart() {
  if (!confirm("Home Assistant jetzt neu starten? Das dauert meist 30–90 Sekunden.")) return;
  S.job = { status: "running", logs: [] };
  render();
  const { job } = await api("/api/restart", { method: "POST", body: {} });
  streamJob(job.id, async (payload) => {
    if (payload.error) toast(payload.error, true);
    else toast("Home Assistant ist wieder da.");
    S.job = { ...S.job, status: "done" };
    render();
  });
}

async function verify() {
  const data = await api("/api/verify", { method: "POST", body: {} });
  S.checks = data.checks || [];
  toast(data.checks.every((check) => check.ok) ? "Alles in Ordnung." : "Einige Prüfungen sind fehlgeschlagen.", !data.checks.every((check) => check.ok));
  render();
}

async function rollback() {
  if (!confirm("Installation zurücksetzen? Dashboard, Ressourcen, Helper und die gepatchte configuration.yaml werden entfernt.")) return;
  S.view = "apply";
  S.job = { status: "running", logs: [] };
  render();
  const { job } = await api("/api/rollback", { method: "POST", body: {} });
  streamJob(job.id, async () => {
    const session = await api("/api/session");
    absorb(session);
    S.checks = [];
    toast("Zurückgesetzt.");
    render();
  });
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (button.disabled) return;

  try {
    if (action === "reconnect") {
      S.view = "connect";
      render();
    } else if (action === "discover") {
      button.disabled = true;
      await discover();
    } else if (action === "add-room") {
      S.mapping.rooms.push({ key: `raum_${S.mapping.rooms.length + 1}`, name: `Raum ${S.mapping.rooms.length + 1}`, icon: "mdi:home" });
      render();
    } else if (action === "remove-room") {
      S.mapping.rooms.splice(Number(button.dataset.index), 1);
      render();
    } else if (action === "plan") {
      button.disabled = true;
      await makePlan();
    } else if (action === "back-map") {
      S.view = "map";
      render();
    } else if (action === "apply") {
      button.disabled = true;
      await startApply();
    } else if (action === "restart") {
      button.disabled = true;
      await restart();
    } else if (action === "verify") {
      button.disabled = true;
      await verify();
    } else if (action === "rollback") {
      await rollback();
    } else if (action === "recheck") {
      const session = await api("/api/session");
      absorb(session);
      render();
      toast(S.access?.writable ? "Schreibzugriff vorhanden." : "Immer noch kein Schreibzugriff.", !S.access?.writable);
    } else if (action === "reload-page") {
      location.reload();
    } else if (action === "open-dashboard") {
      window.open(button.dataset.href, "_blank", "noopener");
    } else if (action === "reload") {
      const session = await api("/api/session");
      absorb(session);
      render();
    }
  } catch (error) {
    toast(error.message, true);
    render();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === "login") {
      const code = new FormData(form).get("code");
      const session = await api("/api/login", { method: "POST", body: { code } });
      absorb(session);
      S.view = "connect";
      render();
      if (session.connected) await discover(true);
    } else if (form.dataset.form === "connect") {
      const data = new FormData(form);
      const result = await api("/api/connect", { method: "POST", body: { url: data.get("url"), token: data.get("token") } });
      S.access = result.access;
      S.session = { ...S.session, connected: { ...result.ha, url: data.get("url") } };
      S.connected = true;
      S.view = "connect";
      render();
      await discover(true);
      toast("Verbunden.");
    }
  } catch (error) {
    toast(error.message, true);
    if (submit) submit.disabled = false;
  }
});

document.addEventListener("change", (event) => {
  const element = event.target;
  const kind = element.dataset.kind;
  if (kind === "room" && element.dataset.field) {
    const room = S.mapping.rooms[Number(element.dataset.index)];
    if (room) room[element.dataset.field] = element.value;
  } else if (kind === "global" && element.dataset.field) {
    const field = element.dataset.field;
    if (field === "speaker") {
      S.mapping.global.speakers = element.value ? [element.value] : [];
    } else {
      S.mapping.global[field] = element.value;
    }
  } else if (kind === "option" && element.dataset.field) {
    S.options[element.dataset.field] = element.checked;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.dataset.kind === "room-name") {
    const room = S.mapping.rooms[Number(event.target.dataset.index)];
    if (room) room.name = event.target.value;
  }
});

boot();
