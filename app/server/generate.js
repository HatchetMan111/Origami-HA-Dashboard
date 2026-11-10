import YAML from "yaml";
import { DASHBOARD_ICON, DASHBOARD_TITLE, DASHBOARD_URL_PATH } from "./config.js";
import { readPart } from "./vendor.js";

const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const EXAMPLE_SCENES = [
  "scene.living_room_night",
  "scene.living_room_morning",
  "scene.living_room_dinner",
  "scene.living_room_evening",
  "scene.living_room_movie",
  "scene.living_room_late",
];

export function looksEntity(value) {
  return typeof value === "string" && ENTITY_RE.test(value);
}

function parse(text) {
  return YAML.parse(text);
}

function replaceIds(text, dict) {
  let out = text;
  for (const key of Object.keys(dict).sort((a, b) => b.length - a.length)) {
    out = out.split(key).join(dict[key]);
  }
  return out;
}

function mapTree(node, dict) {
  if (typeof node === "string") return replaceIds(node, dict);
  if (Array.isArray(node)) return node.map((item) => mapTree(item, dict));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = mapTree(value, dict);
    return out;
  }
  return node;
}

function replaceIdList(text, needle, ids) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[[^\\[\\]]*${escaped}[^\\[\\]]*\\]`, "g");
  return text.replace(re, JSON.stringify(ids));
}

function removeInArrays(node, predicate) {
  if (Array.isArray(node)) {
    return node.filter((item) => !predicate(item)).map((item) => removeInArrays(item, predicate));
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) node[key] = removeInArrays(node[key], predicate);
  }
  return node;
}

function pruneButtons(list, ctx) {
  if (!Array.isArray(list)) return list;
  return list
    .filter((item) => {
      if (!item || typeof item !== "object") return true;
      const id = item.entity;
      if (!looksEntity(id)) return true;
      if (id.startsWith("input_boolean.") || id.startsWith("input_select.")) return true;
      return ctx.known.has(id);
    })
    .map((item) => {
      if (Array.isArray(item.group)) item.group = pruneButtons(item.group, ctx);
      return item;
    });
}

function roomDict(room) {
  const dict = {};
  const set = (key, value) => {
    if (value) dict[key] = value;
  };
  set("light.living_room", room.light || room.lights?.[0]);
  set("sensor.living_room_temperature", room.temperature);
  set("sensor.living_room_humidity", room.humidity);
  set("binary_sensor.living_room_window", room.window);
  set("climate.living_room", room.climate);
  set("media_player.living_room", room.media);
  return dict;
}

function buildDict(mapping) {
  const rooms = (mapping.rooms || []).map((room, index) => ({ ...room, _index: index }));
  const global = mapping.global || {};
  const dict = {};
  const set = (key, value) => {
    if (value) dict[key] = value;
  };

  set("weather.home", global.weather);
  set("calendar.household", global.calendar);
  set("vacuum.robot", global.vacuum);
  set("media_player.living_room_tv", global.tv);

  (global.speakers || []).forEach((id, index) => {
    const example = ["media_player.bedroom", "media_player.office"][index];
    if (example) set(example, id);
  });

  rooms.forEach((room) => Object.assign(dict, roomDict(room)));
  if (global.groupLight) dict["light.living_room"] = global.groupLight;

  (global.scenes || []).forEach((id, index) => {
    if (EXAMPLE_SCENES[index]) set(EXAMPLE_SCENES[index], id);
  });

  return { dict, rooms };
}

function buildGreeting(dict, ctx) {
  let card = mapTree(parse(readPart("dashboard/greeting/card.yaml")), dict);
  if (!Array.isArray(card.cards) || !card.cards.length) return card;
  if (!ctx.options.notifications) {
    card.cards = [card.cards[0]];
    card.columns = 1;
    return card;
  }
  const island = card.cards[1];
  if (!island) return card;
  if (!dict["weather.home"]) delete island.weather;
  island.entities = (island.entities || []).filter((entry) => {
    const id = typeof entry === "string" ? entry : entry?.entity;
    if (!looksEntity(id)) return true;
    if (id.startsWith("input_")) return true;
    return ctx.known.has(id);
  });
  if (card.cards[0]?.sub_button?.main) {
    card.cards[0].sub_button.main = pruneButtons(card.cards[0].sub_button.main, ctx);
  }
  return card;
}

function buildWeather(dict, ctx) {
  let text = readPart("dashboard/weather/diorama.yaml");
  text = replaceIds(text, { "weather.home": dict["weather.home"] || "weather.home" });
  if (ctx.options.localAssets) {
    text = text.replaceAll(
      "https://cdn.jsdelivr.net/gh/hazymorning/origami@main/dashboard/",
      "/local/origami/",
    );
  }
  return parse(text);
}

function buildRoomsHeader(dict, ctx) {
  const temps = ctx.rooms.map((room) => room.temperature).filter(Boolean);
  const hums = ctx.rooms.map((room) => room.humidity).filter(Boolean);
  const windows = ctx.rooms.map((room) => room.window).filter(Boolean);

  let text = readPart("dashboard/rooms/header.yaml");
  text = replaceIdList(text, "sensor.living_room_temperature", temps);
  text = replaceIdList(text, "sensor.living_room_humidity", hums);
  text = replaceIdList(text, "binary_sensor.living_room_window", windows);

  let card = mapTree(parse(text), dict);
  card.sub_button = card.sub_button || {};
  card.sub_button.main = pruneButtons(card.sub_button?.main || [], ctx).filter((item) => {
    if (item.name === "Temperature") return temps.length > 0;
    if (item.name === "Windows") return windows.length > 0;
    if (item.entity === "input_boolean.climate_table") return ctx.options.climateTable;
    return true;
  });
  return card;
}

function roomHasCards(room) {
  return Boolean(room.light || room.climate || room.temperature || room.media || room.window || (room.lights || []).length);
}

function roomHasClimate(room) {
  return Boolean(room.temperature || room.humidity || room.window || room.climate);
}

function buildRoomCard(room, dict, ctx) {
  let card = mapTree(parse(readPart("dashboard/rooms/room.yaml")), { ...dict, ...roomDict(room) });
  card.name = room.name;
  card.icon = room.icon || "mdi:home";
  card.entity = room.light || room.climate || room.temperature || room.media || room.window || "";
  // Room pop-ups arrive in v0.2; for now a tap opens the entity dialog.
  card.button_action = {
    ...card.button_action,
    tap_action: { action: "more-info" },
  };
  card.sub_button = card.sub_button || {};
  card.sub_button.main = pruneButtons(card.sub_button?.main || [], ctx);
  card.sub_button.bottom = pruneButtons(card.sub_button?.bottom || [], ctx);
  return card;
}

function buildClimateTable(rooms, dict, ctx) {
  const temps = rooms.map((room) => room.temperature).filter(Boolean);
  const hums = rooms.map((room) => room.humidity).filter(Boolean);

  let text = readPart("dashboard/climate-table/card.yaml");
  text = replaceIdList(text, "sensor.living_room_temperature", temps);
  text = replaceIdList(text, "sensor.living_room_humidity", hums);

  const card = parse(text);
  const climateRooms = rooms.filter(roomHasClimate);
  const template = card.sub_button?.bottom?.[0];
  if (template && climateRooms.length) {
    card.sub_button.bottom = climateRooms.map((room) => {
      const group = structuredClone(template);
      group.name = room.name;
      const roomIds = roomDict(room);
      group.group = (group.group || [])
        .filter((item) => {
          const cls = item.css_class;
          if (cls === "window") return Boolean(room.window);
          if (cls === "thermostat") return Boolean(room.climate);
          if (cls === "humidity") return Boolean(room.humidity);
          return true;
        })
        .map((item) => mapTree(item, roomIds));
      return group;
    });
  } else if (card.sub_button) {
    card.sub_button.bottom = [];
  }
  return mapTree(card, dict);
}

function lightEntities(mapping, ctx) {
  const ids = (mapping.global?.lights || []).concat(ctx.rooms.flatMap((room) => room.lights || []));
  return [...new Set(ids.filter(Boolean))];
}

function buildLightsPopup(mapping, dict, ctx) {
  const lights = lightEntities(mapping, ctx);
  const lamps = lights.filter((id) => !ctx.stateById.get(id)?.attributes?.entity_id).slice(0, 12);
  const group = mapping.global?.groupLight || lamps[0];
  if (!group) return null;

  let text = readPart("dashboard/lights/pop-up.yaml");
  const expand = lamps.length ? `expand(${lamps.map((id) => `'${id}'`).join(", ")})` : `expand('${group}')`;
  text = text.split("expand('light.living_room')").join(expand);

  let card = mapTree(parse(text), { ...dict, "light.living_room": group });

  const lampCard = card.origami_popup?.mini_popups?.lamps?.[0];
  if (lampCard) {
    lampCard.sub_button.bottom = lamps.map((id) => ({
      entity: id,
      name: ctx.nameOf(id),
      sub_button_type: "slider",
      always_visible: true,
      allow_light_slider_to_0: true,
    }));
  }

  // Scenes are left out in v0.1: they need the home's own time-of-day scenes. The pop-up keeps the lamps.
  const inner = card.cards?.[0]?.cards;
  if (Array.isArray(inner)) {
    card.cards[0].cards = inner.filter((item) => item.card_type === "button");
    const head = card.cards[0].cards[0];
    if (head?.sub_button?.main) {
      head.sub_button.main = head.sub_button.main.slice(0, 1).map((button) => ({
        ...button,
        origami_base: { ...(button.origami_base || {}), hidden: undefined },
        tap_action: {
          action: "perform-action",
          perform_action: "light.toggle",
          target: { entity_id: group },
        },
      }));
      if (head.sub_button.main[0]) delete head.sub_button.main[0].origami_base.hidden;
    }
  }
  card = removeInArrays(card, (item) => item && typeof item === "object" && item.mini_popup === "scenes");
  if (card.origami_popup?.mini_popups) delete card.origami_popup.mini_popups.scenes;

  return card;
}

function buildNavbar(dict, ctx) {
  let card = parse(readPart("dashboard/navigation-bar/card.yaml"));
  delete card.media_player;
  const group = dict["light.living_room"];
  const allowed = new Set();
  if (ctx.options.lightsPopup && group) allowed.add("#popup_lights");
  if (ctx.options.menu) allowed.add("#popup_menu");

  card.routes = (card.routes || []).filter((route) => {
    const path = route.tap_action?.navigation_path;
    if (!path) return true;
    if (path.startsWith("#")) return allowed.has(path);
    return false;
  });

  const lightsRoute = card.routes.find((route) => route.tap_action?.navigation_path === "#popup_lights");
  if (lightsRoute?.popup && group) {
    lightsRoute.popup = lightsRoute.popup
      .filter((item) => !item.tap_action?.perform_action?.startsWith("scene."))
      .map((item) => {
        if (item.tap_action?.target?.entity_id === "all" || item.tap_action?.target?.entity_id === "light.living_room") {
          item.tap_action.target.entity_id = group;
        }
        return item;
      });
  }
  return card;
}

function buildMenu(ctx) {
  const card = mapTree(parse(readPart("dashboard/menu/card.yaml")), {});
  delete card.cards;
  return card;
}

export function buildHelpers(mapping, options) {
  const helpers = [];
  if (options.climateTable) {
    helpers.push({ domain: "input_boolean", name: "Climate table", entity: "input_boolean.climate_table" });
  }
  if (options.allRooms) {
    helpers.push({ domain: "input_boolean", name: "All rooms", entity: "input_boolean.all_rooms" });
  }
  return helpers;
}

export function buildDashboard(mapping, options, runtime = {}) {
  const ctx = {
    options,
    rooms: mapping.rooms || [],
    known: new Set(runtime.knownEntities || []),
    stateById: new Map((runtime.states || []).map((state) => [state.entity_id, state])),
    nameOf(id) {
      return this.stateById.get(id)?.attributes?.friendly_name || id;
    },
  };
  const { dict, rooms } = buildDict(mapping);

  const cards = [];
  if (options.greeting) cards.push(buildGreeting(dict, ctx));
  if (options.weather && mapping.global?.weather) cards.push(buildWeather(dict, ctx));
  if (options.rooms && rooms.length) {
    cards.push(buildRoomsHeader(dict, ctx));
    rooms.forEach((room, index) => {
      if (!roomHasCards(room)) return;
      const card = buildRoomCard(room, dict, ctx);
      if (options.allRooms && rooms.length > 3 && index >= 3) {
        card.visibility = [
          { condition: "state", entity: "input_boolean.all_rooms", state: "on" },
        ];
      }
      cards.push(card);
    });
    if (options.allRooms && rooms.length > 3) {
      cards.push(mapTree(parse(readPart("dashboard/rooms/all-rooms.yaml")), dict));
    }
  }
  if (options.climateTable && rooms.length) cards.push(buildClimateTable(rooms, dict, ctx));
  if (options.menu) cards.push(buildMenu(ctx));
  if (options.lightsPopup) {
    const popup = buildLightsPopup(mapping, dict, ctx);
    if (popup) cards.push(popup);
  }
  if (options.navigationBar) cards.push(buildNavbar(dict, ctx));

  const config = {
    title: DASHBOARD_TITLE,
    views: [
      {
        title: "Home",
        path: "home",
        icon: "mdi:home",
        type: "sections",
        max_columns: 1,
        sections: [{ type: "grid", cards }],
      },
    ],
  };

  return {
    config,
    urlPath: DASHBOARD_URL_PATH,
    title: DASHBOARD_TITLE,
    icon: DASHBOARD_ICON,
    helpers: buildHelpers(mapping, options),
    missingEntities: findMissingEntities(config, ctx.known, options),
    stats: {
      cards: cards.length,
      rooms: rooms.length,
      views: config.views.length,
    },
  };
}

function findMissingEntities(config, known, options) {
  const ignore = new Set([
    "input_boolean.all_rooms",
    "input_boolean.climate_table",
    "input_boolean.music_pop_up",
    "input_boolean.vacuum_no_go_zones",
    "input_select.selected_speaker",
    "input_select.vacuum_passes",
    "timer.bedroom_fan",
    "timer.kitchen",
    "counter.vacuum_bin",
    "script.group_speakers",
    "script.playback",
    "script.thermostat_step",
    "script.volume",
    "script.vacuum_empty_bin",
  ]);
  const serviceKeys = new Set(["perform_action", "service", "action"]);
  const found = new Set();
  const scan = (node, key) => {
    if (typeof node === "string") {
      if (serviceKeys.has(key)) return;
      for (const match of node.matchAll(/\b(?:light|switch|sensor|binary_sensor|climate|media_player|cover|fan|vacuum|scene|calendar|weather|person|todo|remote|camera)\.[a-z0-9_]+\b/g)) {
        const id = match[0];
        if (!known.has(id) && !ignore.has(id)) found.add(id);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => scan(item, key));
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, value] of Object.entries(node)) scan(value, childKey);
    }
  };
  scan(config, "");
  return [...found].sort().slice(0, 80);
}

export function buildPlanSummary(dashboard, plugins, files) {
  return {
    dashboard: {
      urlPath: dashboard.urlPath,
      title: dashboard.title,
      cards: dashboard.stats.cards,
      rooms: dashboard.stats.rooms,
    },
    helpers: dashboard.helpers,
    plugins: plugins.map((plugin) => plugin.key),
    files,
    missingEntities: dashboard.missingEntities,
  };
}
