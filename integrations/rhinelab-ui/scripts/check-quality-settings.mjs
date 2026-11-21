import assert from "node:assert/strict";
import { qualityMarkup, syncQualityUI } from "../src/quality-settings.ts";

const markup = qualityMarkup();
assert.deepEqual([...markup.matchAll(/data-performance-mode="([^"]+)"/g)].map(match => match[1]), ["original", "smooth"]);
assert.equal((markup.match(/type="button"/g) ?? []).length, 2, "Both modes use native keyboard-operable buttons");
assert.match(markup, /data-performance-mode="original" aria-pressed="true"/);
assert.match(markup, /data-performance-mode="smooth" aria-pressed="false"/);
assert.ok(!/<(?:select|input|details)\b|data-quality=|quality-summary/.test(markup), "The settings UI contains no advanced quality controls or technical summary");
assert.match(qualityMarkup("smooth"), /data-performance-mode="smooth" aria-pressed="true"/);

const pressed = {};
const previousDocument = globalThis.document;
globalThis.document = {
  querySelectorAll(selector) {
    assert.equal(selector, ".quality-settings [data-performance-mode]");
    return ["original", "smooth"].map(mode => ({
      dataset: { performanceMode: mode },
      setAttribute(name, value) { assert.equal(name, "aria-pressed"); pressed[mode] = value; },
    }));
  },
};
try {
  syncQualityUI("smooth");
  assert.deepEqual(pressed, { original: "false", smooth: "true" });
  syncQualityUI();
  assert.deepEqual(pressed, { original: "true", smooth: "false" });
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
console.log("Two-mode performance UI passed: original default, selection state and advanced controls removed.");
