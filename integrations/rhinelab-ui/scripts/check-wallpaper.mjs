import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const events = [];
const hostWindow = { dispatchEvent: event => events.push(event) };
vm.runInNewContext(readFileSync("wallpaper/host.js", "utf8"), {
  window: hostWindow, Event, CustomEvent, location: { protocol: "file:" },
});
const listener = hostWindow.wallpaperPropertyListener;
listener.applyUserProperties({ sound: { value: false } });
listener.applyUserProperties({ musicvolume: { value: 15 } });
assert.equal(hostWindow.rhineWallpaperHost.properties.sound.value, false);
assert.equal(hostWindow.rhineWallpaperHost.properties.musicvolume.value, 15);
assert.equal(events.length, 2, "Early and partial callbacks are retained and dispatched");
listener.applyGeneralProperties({ fps: 30 });
listener.applyGeneralProperties({ fps: NaN });
assert.equal(hostWindow.rhineWallpaperHost.fps, 30);
globalThis.window = hostWindow;
const documentListeners = {};
globalThis.document = { documentElement: { dataset: {} }, addEventListener: (type, handler) => { documentListeners[type] = handler; } };
const source = readFileSync("src/wallpaper.ts", "utf8").replace('import.meta.env.MODE', '"wallpaper"');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const wallpaperModule = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { wallpaperFrame } = await import(wallpaperModule);
let rendered = 0;
for (let i = 0; i < 120; i++) if (wallpaperFrame(i * 1000 / 60)) rendered++;
assert.ok(rendered >= 59 && rendered <= 61, `30 FPS host limit at 60 Hz: ${rendered} / 2 s`);
listener.setPaused(true);
assert.equal(wallpaperFrame(10000), false);
listener.setPaused(false);
assert.equal(wallpaperFrame(10001), true, "Resume renders immediately without catch-up frames");
listener.applyGeneralProperties({ fps: 15 });
rendered = 0;
for (let i = 1; i <= 120; i++) if (wallpaperFrame(10001 + i * 1000 / 60)) rendered++;
assert.ok(rendered >= 29 && rendered <= 31, `Live 15 FPS limit: ${rendered} / 2 s`);
await import("./check-quality-settings.mjs");
console.log("Wallpaper early properties, partial updates, FPS changes, pause/resume and two-mode performance controls passed.");
