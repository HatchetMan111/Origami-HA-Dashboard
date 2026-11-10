const ICONS = [
  [/küche|kueche|kitchen|cook/i, "mdi:silverware-fork-knife"],
  [/wohn|living|lounge/i, "mdi:sofa"],
  [/schlaf|bedroom|bett/i, "mdi:bed"],
  [/bad|bath|wc|toilet/i, "mdi:shower"],
  [/büro|buero|office|arbeit/i, "mdi:desk"],
  [/kind|nursery|kids/i, "mdi:teddy-bear"],
  [/flur|hall|corridor|diele/i, "mdi:door"],
  [/garten|garden|terrasse|terrace|outdoor/i, "mdi:flower"],
  [/garage|carport|einfahrt/i, "mdi:garage"],
  [/keller|basement|cellar/i, "mdi:stairs-down"],
  [/dach|attic|loft/i, "mdi:home-roof"],
  [/wasch|laundry|utility|technik/i, "mdi:washing-machine"],
];

function guessIcon(name = "") {
  for (const [re, icon] of ICONS) if (re.test(name)) return icon;
  return "mdi:home";
}

const nameOf = (state) => state?.attributes?.friendly_name || state?.entity_id || "";

function sortByName(list, statesById) {
  return list.sort((a, b) => nameOf(statesById.get(a)).localeCompare(nameOf(statesById.get(b)), "de"));
}

export function discover({ states, registries, config }) {
  const statesById = new Map((states || []).map((state) => [state.entity_id, state]));
  const known = new Set(statesById.keys());

  const devicesById = new Map((registries.devices || []).map((device) => [device.id, device]));
  const entityRows = (registries.entities || []).filter((row) => !row.disabled_by && !row.hidden_by);

  const areaOf = (row) => row.area_id || devicesById.get(row.device_id)?.area_id || null;
  const rowsByArea = new Map();
  for (const row of entityRows) {
    const area = areaOf(row);
    if (!area) continue;
    if (!rowsByArea.has(area)) rowsByArea.set(area, []);
    rowsByArea.get(area).push(row);
  }

  const domainOf = (row) => row.entity_id.split(".")[0];
  const pick = (rows, predicate) =>
    rows.find((row) => predicate(row, statesById.get(row.entity_id)) && known.has(row.entity_id));

  const rooms = [];
  for (const area of registries.areas || []) {
    const rows = rowsByArea.get(area.area_id) || [];
    if (!rows.length) continue;

    const lights = sortByName(
      rows.filter((r) => domainOf(r) === "light").map((r) => r.entity_id),
      statesById,
    );
    const nonGroupLights = lights.filter((id) => !statesById.get(id)?.attributes?.entity_id);
    const temperature = pick(rows, (r, s) =>
      r.entity_id.startsWith("sensor.") &&
      (r.device_class === "temperature" || s?.attributes?.device_class === "temperature"),
    )?.entity_id;
    const humidity = pick(rows, (r, s) =>
      r.entity_id.startsWith("sensor.") &&
      (r.device_class === "humidity" || s?.attributes?.device_class === "humidity"),
    )?.entity_id;
    const window = pick(rows, (r, s) => {
      if (!r.entity_id.startsWith("binary_sensor.")) return false;
      const dc = r.device_class || s?.attributes?.device_class;
      return ["window", "door", "opening", "garage_door"].includes(dc);
    })?.entity_id;
    const climate = pick(rows, (r) => r.entity_id.startsWith("climate."))?.entity_id;
    const media = pick(rows, (r) => r.entity_id.startsWith("media_player."))?.entity_id;
    const cover = pick(rows, (r) => r.entity_id.startsWith("cover."))?.entity_id;
    const fan = pick(rows, (r) => r.entity_id.startsWith("fan."))?.entity_id;

    if (!lights.length && !temperature && !climate && !media && !window) continue;

    const key = (area.name || area.area_id)
      .toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      .slice(0, 40) || area.area_id;

    rooms.push({
      key,
      name: area.name || area.area_id,
      icon: area.icon || guessIcon(area.name),
      light: nonGroupLights[0] || lights[0] || "",
      lights,
      temperature: temperature || "",
      humidity: humidity || "",
      window: window || "",
      climate: climate || "",
      media: media || "",
      cover: cover || "",
      fan: fan || "",
    });
  }

  rooms.sort((a, b) => a.name.localeCompare(b.name, "de"));

  const byDomain = (domain) =>
    [...known].filter((id) => id.startsWith(`${domain}.`)).sort((a, b) => nameOf(statesById.get(a)).localeCompare(nameOf(statesById.get(b)), "de"));

  const mediaPlayers = byDomain("media_player");
  const tv =
    mediaPlayers.find((id) => /(^|\.)(tv|fernseher|television)|_tv$|_tv_/i.test(id)) ||
    mediaPlayers.find((id) => /tv|fernseh/i.test(nameOf(statesById.get(id)))) ||
    "";

  const speakers = mediaPlayers.filter((id) => id !== tv);
  const allLights = byDomain("light");
  const groups = allLights.filter((id) => statesById.get(id)?.attributes?.entity_id);
  const groupLight =
    groups.find((id) => /group|alle|all_lights/i.test(id)) || groups[0] || allLights[0] || "";

  const global = {
    weather: byDomain("weather")[0] || "",
    calendar: byDomain("calendar")[0] || "",
    vacuum: byDomain("vacuum")[0] || "",
    tv: tv || "",
    speakers,
    lights: allLights,
    groupLight,
    scenes: byDomain("scene"),
    todos: byDomain("todo"),
    persons: byDomain("person"),
    temperatureUnit: config?.unit_system?.temperature || "°C",
  };

  if (!rooms.length) {
    const fallbackLights = global.lights.filter((id) => !statesById.get(id)?.attributes?.entity_id);
    const temp = [...known].find((id) => {
      const s = statesById.get(id);
      return id.startsWith("sensor.") && s?.attributes?.device_class === "temperature";
    });
    if (fallbackLights.length || temp) {
      rooms.push({
        key: "home",
        name: config?.location_name || "Zuhause",
        icon: "mdi:home",
        light: groupLight || fallbackLights[0] || "",
        lights: fallbackLights,
        temperature: temp || "",
        humidity: "",
        window: "",
        climate: byDomain("climate")[0] || "",
        media: speakers[0] || "",
        cover: "",
        fan: "",
      });
    }
  }

  const components = new Set(config?.components || []);
  return {
    rooms,
    global,
    knownEntities: [...known],
    ha: {
      version: config?.version,
      locationName: config?.location_name,
      unitSystem: config?.unit_system,
      hasBubbleCardTools: components.has("bubble_card_tools"),
    },
    counts: {
      entities: known.size,
      areas: (registries.areas || []).length,
      rooms: rooms.length,
      lights: allLights.length,
      mediaPlayers: mediaPlayers.length,
      scenes: global.scenes.length,
      climates: byDomain("climate").length,
      covers: byDomain("cover").length,
      fans: byDomain("fan").length,
      vacuums: byDomain("vacuum").length,
    },
    warnings: [
      ...(rooms.length ? [] : ["Keine Bereiche (Areas) gefunden. Lege in Home Assistant Bereiche an oder ordne Entitäten manuell zu."]),
      ...(global.weather ? [] : ["Keine Wetter-Entität gefunden – die Wetterkarte wird übersprungen."]),
      ...(allLights.length ? [] : ["Keine Lichter gefunden – das Lichter-Pop-up wird übersprungen."]),
    ],
  };
}
