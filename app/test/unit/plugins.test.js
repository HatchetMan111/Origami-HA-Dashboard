import test from "node:test";
import assert from "node:assert/strict";
import { PLUGINS } from "../../server/plugins.js";

test("every plugin file is pinned to a SHA-256", () => {
  for (const plugin of PLUGINS) {
    if (plugin.kind === "integration") {
      assert.match(plugin.sha256 || "", /^[a-f0-9]{64}$/, `${plugin.key} tarball checksum`);
      continue;
    }
    assert.ok(plugin.files?.length, `${plugin.key} has files`);
    for (const file of plugin.files) {
      assert.match(file.sha256 || "", /^[a-f0-9]{64}$/, `${plugin.key}/${file.to} checksum`);
    }
  }
});

test("plug-in tags are immutable version strings", () => {
  for (const plugin of PLUGINS) {
    assert.ok(!["main", "master", "latest"].includes(plugin.tag), `${plugin.key} uses ${plugin.tag}`);
  }
});
