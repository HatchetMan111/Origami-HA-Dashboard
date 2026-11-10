import test from "node:test";
import assert from "node:assert/strict";
import { discover } from "../../server/discover.js";
import { buildDashboard } from "../../server/generate.js";
import { patchConfigurationText } from "../../server/apply.js";
import { isSynced } from "../../server/vendor.js";

const OPTIONS = {
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

const MAPPING = {
  global: {
    weather: "weather.home",
    calendar: "calendar.family",
    vacuum: "",
    tv: "",
    speakers: [],
    lights: ["light.a", "light.b"],
    groupLight: "light.a",
    scenes: [],
    todos: [],
    persons: [],
    temperatureUnit: "°C",
  },
  rooms: [
    {
      key: "wohnzimmer",
      name: "Wohnzimmer",
      icon: "mdi:sofa",
      light: "light.a",
      lights: ["light.a", "light.b"],
      temperature: "sensor.a_temperature",
      humidity: "sensor.a_humidity",
      window: "binary_sensor.a_window",
      climate: "",
      media: "",
      cover: "",
      fan: "",
    },
  ],
};

const STATES = [
  { entity_id: "light.a", state: "on", attributes: { friendly_name: "Stehlampe" } },
  { entity_id: "light.b", state: "off", attributes: { friendly_name: "Deckenlampe" } },
  { entity_id: "sensor.a_temperature", state: "21.5", attributes: { friendly_name: "Temperatur" } },
  { entity_id: "sensor.a_humidity", state: "48", attributes: { friendly_name: "Feuchte" } },
  { entity_id: "binary_sensor.a_window", state: "off", attributes: { friendly_name: "Fenster" } },
  { entity_id: "weather.home", state: "sunny", attributes: { friendly_name: "Wetter" } },
  { entity_id: "calendar.family", state: "off", attributes: { friendly_name: "Familie" } },
];

test("patchConfigurationText adds a frontend block", () => {
  const result = patchConfigurationText("default_config:\n", { extraModuleUrls: ["/local/x.js"] });
  assert.equal(result.changed, true);
  assert.match(result.text, /^frontend:$/m);
  assert.match(result.text, /themes: !include_dir_merge_named themes/);
  assert.match(result.text, /- \/local\/x\.js/);
});

test("patchConfigurationText keeps an existing frontend block", () => {
  const source = ["default_config:", "frontend:", "  themes: !include_dir_merge_named themes", "http:", "  ip_ban_enabled: true", ""].join("\n");
  const result = patchConfigurationText(source, { extraModuleUrls: ["/local/header.js"] });
  assert.equal(result.changed, true);
  assert.equal((result.text.match(/^frontend:$/gm) || []).length, 1);
  assert.match(result.text, /extra_module_url:\n    - \/local\/header\.js/);
  assert.match(result.text, /^http:$/m);
});

test("patchConfigurationText does not duplicate existing entries", () => {
  const source = [
    "frontend:",
    "  themes: !include_dir_merge_named themes",
    "  extra_module_url:",
    "    - /local/header.js",
    "",
  ].join("\n");
  const result = patchConfigurationText(source, { extraModuleUrls: ["/local/header.js"] });
  assert.equal(result.changed, false);
  assert.equal((result.text.match(/header\.js/g) || []).length, 1);
});

test("patchConfigurationText warns about an inline frontend value", () => {
  const result = patchConfigurationText("frontend: !include frontend.yaml\n", {});
  assert.equal(result.changed, false);
  assert.match(result.warning, /Inline-Wert/);
});

test("discover maps areas to rooms and global entities", () => {
  const registries = {
    areas: [{ area_id: "a1", name: "Wohnzimmer", icon: null }],
    devices: [{ id: "d1", area_id: "a1" }],
    entities: [
      { entity_id: "light.a", device_id: "d1", area_id: null, disabled_by: null, hidden_by: null },
      { entity_id: "sensor.a_temperature", device_id: "d1", area_id: null, device_class: "temperature" },
      { entity_id: "binary_sensor.a_window", device_id: "d1", area_id: null, device_class: "window" },
      { entity_id: "media_player.tv", device_id: null, area_id: "a1" },
    ],
    floors: [],
  };
  const states = [
    ...STATES,
    { entity_id: "media_player.tv", state: "off", attributes: { friendly_name: "Fernseher" } },
    { entity_id: "light.group", state: "on", attributes: { friendly_name: "Alle Lampen", entity_id: ["light.a", "light.b"] } },
  ];
  const result = discover({
    states,
    registries,
    config: { unit_system: { temperature: "°C" }, location_name: "Zuhause" },
  });
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].light, "light.a");
  assert.equal(result.rooms[0].temperature, "sensor.a_temperature");
  assert.equal(result.rooms[0].window, "binary_sensor.a_window");
  assert.equal(result.global.weather, "weather.home");
  assert.equal(result.global.tv, "media_player.tv");
  assert.equal(result.global.groupLight, "light.group");
});

test("buildDashboard renders the home view from real Origami templates", { skip: !isSynced() && "Origami vendor not synced" }, () => {
  const dashboard = buildDashboard(MAPPING, OPTIONS, { knownEntities: STATES.map((s) => s.entity_id), states: STATES });
  assert.ok(dashboard.config.views.length === 1);
  assert.equal(dashboard.stats.rooms, 1);
  assert.ok(dashboard.stats.cards >= 4);

  const json = JSON.stringify(dashboard.config);
  assert.match(json, /light\.a/);
  assert.match(json, /Wohnzimmer/);
  assert.match(json, /sensor\.a_temperature/);
  assert.doesNotMatch(json, /light\.living_room/);
  assert.doesNotMatch(json, /scene\./);
  assert.match(json, /"label":"Turn on"/);
  assert.match(json, /input_boolean\.climate_table/);
  assert.ok(Array.isArray(dashboard.helpers));
  assert.equal(dashboard.helpers[0].entity, "input_boolean.climate_table");
});

test("buildDashboard skips rooms without any entities", { skip: !isSynced() && "Origami vendor not synced" }, () => {
  const mapping = structuredClone(MAPPING);
  mapping.rooms.push({
    key: "leer",
    name: "Leer",
    icon: "mdi:home",
    light: "",
    lights: [],
    temperature: "",
    humidity: "",
    window: "",
    climate: "",
    media: "",
    cover: "",
    fan: "",
  });
  const dashboard = buildDashboard(mapping, OPTIONS, { knownEntities: STATES.map((s) => s.entity_id), states: STATES });
  const json = JSON.stringify(dashboard.config);
  assert.doesNotMatch(json, /Leer/);
  assert.equal(dashboard.stats.rooms, 2);
});
