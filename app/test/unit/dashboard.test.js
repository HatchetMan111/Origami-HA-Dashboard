import test from "node:test";
import assert from "node:assert/strict";
import { ensureDashboard } from "../../server/apply.js";

test("ensureDashboard rejects a url path without a hyphen", async () => {
  await assert.rejects(
    () => ensureDashboard({}, { urlPath: "origami", config: { views: [] } }),
    /Bindestrich/,
  );
});

test("ensureDashboard creates a dashboard with a hyphenated path", async () => {
  const created = [];
  const ha = {
    dashboards: async () => [],
    createDashboard: async (payload) => {
      created.push(payload);
      return { id: "dash-1" };
    },
    saveDashboard: async () => {},
  };

  const id = await ensureDashboard(ha, {
    urlPath: "origami-dashboard",
    title: "Origami",
    icon: "mdi:origami",
    config: { views: [] },
  });

  assert.equal(id, "dash-1");
  assert.equal(created.length, 1);
  assert.equal(created[0].url_path, "origami-dashboard");
  assert.equal(created[0].title, "Origami");
});

test("ensureDashboard reuses an existing dashboard", async () => {
  const ha = {
    dashboards: async () => [{ id: "dash-2", url_path: "origami-dashboard" }],
    createDashboard: async () => assert.fail("must not create"),
    saveDashboard: async () => {},
  };

  const id = await ensureDashboard(ha, {
    urlPath: "origami-dashboard",
    title: "Origami",
    config: { views: [] },
  });

  assert.equal(id, "dash-2");
});
