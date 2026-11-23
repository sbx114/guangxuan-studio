import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';

const script = fileURLToPath(import.meta.url);
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--source', '--output', '--worker', '--observe-ms', '--watchdog-ms'].includes(key) || !value || values.has(key)) throw new Error('Unsupported or duplicate diagnostic argument');
  values.set(key, value);
}
const source = path.resolve(values.get('--source') || process.cwd());
const output = path.resolve(values.get('--output') || path.join(process.cwd(), '.ci-evidence', 'ui-startup'));
const observeMs = Number(values.get('--observe-ms') || 16000), watchdogMs = Number(values.get('--watchdog-ms') || 30000);
if (!Number.isInteger(observeMs) || observeMs < 12000 || observeMs > 20000 || !Number.isInteger(watchdogMs) || watchdogMs < observeMs + 8000 || watchdogMs > 45000) throw new Error('Diagnostic budget is out of bounds');
const modes = {
  default: [],
  'current-cpu': ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  'webgl-disabled': ['--disable-webgl', '--disable-webgl2'],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const serializeError = error => ({ name: error?.name || 'Error', message: String(error?.message || error).slice(0, 5000) });
async function bounded(label, operation, milliseconds) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(label + ' exceeded ' + milliseconds + 'ms'), { name: 'DiagnosticOperationTimeout' })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function worker(mode) {
  if (!Object.hasOwn(modes, mode)) throw new Error('Unsupported diagnostic mode');
  const directory = path.join(output, mode), start = Date.now(); await mkdir(directory, { recursive: true });
  let writeTail = Promise.resolve();
  const emit = (kind, detail = {}) => {
    const event = { at: new Date().toISOString(), elapsedMs: Date.now() - start, pid: process.pid, mode, kind, ...detail };
    const line = JSON.stringify(event) + '\n'; process.stdout.write(line);
    writeTail = writeTail.then(() => appendFile(path.join(directory, 'events.ndjson'), line)).catch(() => {});
    return event;
  };
  let app, browserServer, browser, page, observedAt, fatal;
  const operations = [], snapshots = [], forbiddenRequests = [], failures = [];
  const step = async (label, operation, budget = 2000) => {
    emit('operation-start', { label, budget }); const at = Date.now();
    try { const result = await bounded(label, operation, budget); const row = { label, status: 'completed', durationMs: Date.now() - at }; operations.push(row); emit('operation-end', row); return { ok: true, value: result }; }
    catch (error) { const row = { label, status: 'failed', durationMs: Date.now() - at, error: serializeError(error) }; operations.push(row); failures.push(row); emit('operation-end', row); return { ok: false }; }
  };
  try {
    emit('worker-start', { node: process.version, platform: process.platform, architecture: process.arch, browserArgs: modes[mode], source, output: directory, observeMs, watchdogMs, cpuCount: os.availableParallelism?.() ?? os.cpus().length });
    const temp = path.join(directory, 'tmp'); await mkdir(temp, { recursive: true });
    const canonicalTemp = await realpath(temp); process.env.TEMP = canonicalTemp; process.env.TMP = canonicalTemp; process.env.GUANGXUAN_TEST_DIR = canonicalTemp; process.env.GUANGXUAN_TEST_TMP = canonicalTemp;
    emit('canonical-temp', { directory: canonicalTemp });
    const sourceFiles = {};
    for (const relative of ['package.json', 'public/rhine/index.html', 'integrations/rhinelab-ui/src/main.ts']) {
      try { const bytes = await readFile(path.join(source, relative)); sourceFiles[relative] = { bytes: bytes.length, sha256: digest(bytes) }; }
      catch (error) { sourceFiles[relative] = { error: serializeError(error) }; }
    }
    const { chromium } = createRequire(path.join(source, 'package.json'))('playwright-core');
    const { startServer } = await import(pathToFileURL(path.join(source, 'server.mjs')));
    emit('server-imported', { sourceFiles });
    app = await bounded('startServer', () => startServer({ port: 0, dataDir: path.join(directory, 'data') }), 8000);
    if (new URL(app.url).port === '4417') throw new Error('Diagnostic must never use the managed user port');
    emit('server-listening', { url: app.url, isolatedData: true });
    const project = { kind: 'writing', title: 'Synthetic startup diagnostic', source: { text: 'Synthetic local startup fixture. No user material.' }, writing: { brief: { channel: 'article' }, draft: { channel: 'article', output: { title: 'Synthetic startup diagnostic', body: 'No model is used.' }, evidence: [], notes: [] } } };
    const response = await bounded('seed-synthetic-project', () => fetch(app.url + '/api/projects/startup-diagnostic', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) }), 2000);
    if (response.status !== 200) throw new Error('Synthetic project creation failed'); await response.arrayBuffer();
    browserServer = await bounded('launch-Edge', () => chromium.launchServer({ channel: 'msedge', headless: true, args: modes[mode], timeout: 10000 }), 11000);
    const child = browserServer.process(); emit('browser-started', { browserPid: child.pid, command: child.spawnfile, args: child.spawnargs, browserChannel: 'msedge', headless: true });
    child.stderr?.on('data', chunk => emit('browser-stderr', { text: chunk.toString().slice(0, 6000) }));
    child.on('exit', (code, signal) => emit('browser-process-exit', { browserPid: child.pid, code, signal }));
    browser = await bounded('connect-Edge', () => chromium.connect(browserServer.wsEndpoint(), { timeout: 3000 }), 3500);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.exposeBinding('__gxStartupDiagnosticEvent', (binding, event) => emit('renderer-event', { frameUrl: binding.frame.url(), event }));
    await context.addInitScript(() => {
      let messages = 0;
      const report = (stage, detail = {}) => { if (messages++ > 100) return; void window.__gxStartupDiagnosticEvent({ stage, rendererNow: performance.now(), framePath: location.pathname, ...detail }).catch(() => {}); };
      report('init-script');
      window.addEventListener('DOMContentLoaded', () => report('dom-content-loaded'));
      window.addEventListener('load', () => report('window-load'));
      window.addEventListener('error', event => report('window-error', { message: event.message || String(event.type), filename: event.filename, line: event.lineno }));
      window.addEventListener('unhandledrejection', event => report('unhandled-rejection', { message: String(event.reason?.stack || event.reason).slice(0, 4000) }));
      try { new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.name.startsWith('gx:')) report('performance-mark', { name: entry.name, startTime: entry.startTime }); }).observe({ type: 'mark', buffered: true }); } catch {}
      setTimeout(() => report('renderer-timer-1000'), 1000);
      setTimeout(() => report('renderer-timer-12000'), 12000);
    });
    page = await context.newPage();
    page.setDefaultTimeout(1500); page.setDefaultNavigationTimeout(4000);
    page.on('console', message => emit('console', { type: message.type(), text: message.text().slice(0, 6000), location: message.location() }));
    page.on('pageerror', error => emit('pageerror', serializeError(error)));
    page.on('crash', () => emit('page-crash'));
    page.on('close', () => emit('page-close'));
    page.on('frameattached', frame => emit('frame-attached', { url: frame.url() }));
    page.on('framenavigated', frame => emit('frame-navigated', { url: frame.url() }));
    let requestCount = 0;
    page.on('request', request => { requestCount++; if (/\.glb|\/rhine\/index|\/rhine\/assets\/.+\.(?:js|css)|\/api\/projects|\/api\/(?:ai|assistant\/runs)/.test(request.url())) emit('request', { url: request.url(), method: request.method(), resourceType: request.resourceType() }); });
    page.on('requestfinished', request => { if (/\.glb|\/rhine\/assets\/.+\.js|\/api\/projects/.test(request.url())) emit('request-finished', { url: request.url() }); });
    page.on('requestfailed', request => emit('request-failed', { url: request.url(), error: request.failure()?.errorText, method: request.method() }));
    page.on('response', response => { if (response.status() >= 400) emit('http-error', { url: response.url(), status: response.status() }); });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== app.url || request.method() === 'POST' && /^\/api\/(?:ai|assistant\/runs)(?:\/|$)/.test(url.pathname)) { forbiddenRequests.push({ url: request.url(), method: request.method() }); emit('request-blocked', forbiddenRequests.at(-1)); return route.abort('blockedbyclient'); }
      if (url.pathname === '/rhine/index.html') {
        // Match the existing failing real-index tests, not a simplified DOM.
        url.searchParams.set('review', '1'); url.searchParams.set('skipBoot', '1'); url.searchParams.set('scene', 'archive'); return route.continue({ url: url.href });
      }
      return route.continue();
    });
    observedAt = Date.now(); emit('observation-start', { observationDurationMs: observeMs });
    const goto = page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 4000 }).then(() => emit('goto-completed')).catch(error => emit('goto-failed', serializeError(error)));
    const checkpointTimes = [500, 3000, 8000, observeMs];
    for (const target of checkpointTimes) {
      await delay(Math.max(0, observedAt + target - Date.now()));
      emit('external-checkpoint', { targetMs: target, observationElapsedMs: Date.now() - observedAt, requestCount, frames: page.frames().map(frame => frame.url()), nodeRss: process.memoryUsage().rss });
      const frame = page.frames().find(frame => /\/rhine\/index\.html/.test(frame.url()));
      if (!frame) { snapshots.push({ targetMs: target, status: 'no-home-frame' }); continue; }
      const result = await step('evaluate-home-' + target, () => frame.evaluate(() => {
        const loading = document.querySelector('#loading'), stage = document.querySelector('#stage'), search = document.querySelector('[data-action="search"]'), assistant = document.querySelector('[data-action="assistant"]');
        const box = element => { if (!element) return null; const rect = element.getBoundingClientRect(), style = getComputedStyle(element); const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents, inert: element.inert, hitElement: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500) }; };
        let stats; try { const all = window.rhine?.stats(); stats = all && { ready: all.ready, startup: all.startup, startupPreparation: all.startupPreparation, mode: all.mode, threeState: all.threeState, firstFramePreparation: all.firstFramePreparation, renderedFrames: all.renderedFrames, shaderPrograms: all.shaderPrograms, fps: all.fps }; } catch (error) { stats = { error: String(error) }; }
        return { href: location.href, documentState: document.readyState, hidden: document.hidden, stats, loading: { present: Boolean(loading), text: loading?.textContent.slice(0, 1500), box: box(loading) }, stage: { mode: stage?.dataset.mode, preparation: stage?.dataset.startupPreparation, inert: stage?.inert }, search: box(search), assistant: box(assistant), notice: document.querySelector('.home-startup-notice')?.textContent, marks: performance.getEntriesByType('mark').filter(item => item.name.startsWith('gx:')).map(item => ({ name: item.name, startTime: item.startTime })), pendingResources: performance.getEntriesByType('resource').filter(item => /\.(?:glb|js|css)|\/api\/projects/.test(item.name)).map(item => ({ name: item.name, duration: item.duration, transferSize: item.transferSize })), dom: document.documentElement.outerHTML.slice(-45000) };
      }), 1500);
      const snapshot = { targetMs: target, status: result.ok ? 'read' : 'evaluation-timeout-or-error', ...(result.ok ? { state: result.value } : {}) }; snapshots.push(snapshot); await writeFile(path.join(directory, 'snapshots.json'), JSON.stringify(snapshots, null, 2));
      if (!result.ok) emit('renderer-unresponsive-at-checkpoint', { targetMs: target });
    }
    await Promise.race([goto, delay(50)]);
    await step('dom-content', async () => { const html = await page.content(); await writeFile(path.join(directory, 'host-dom.html'), html); const frame = page.frames().find(frame => /\/rhine\/index\.html/.test(frame.url())); if (frame) await writeFile(path.join(directory, 'home-dom.html'), await frame.content()); }, 1500);
    await step('screenshot', () => page.screenshot({ path: path.join(directory, 'viewport.png'), timeout: 2000, animations: 'disabled', fullPage: false }), 2200);
    emit('observation-complete', { elapsedMs: Date.now() - observedAt, requestCount, forbiddenRequests });
  } catch (error) { fatal = serializeError(error); emit('worker-fatal', { error: fatal }); }
  finally {
    const cleanup = [];
    if (browserServer) { const closed = await step('browser-close', () => browserServer.close(), 2000); cleanup.push({ type: 'browser', normalClose: closed.ok }); }
    if (app) { const closed = await step('isolated-server-close', () => app.close(), 2000); cleanup.push({ type: 'server', normalClose: closed.ok }); }
    await writeTail;
    const result = { status: fatal ? 'diagnostic-failed' : 'diagnostic-collected', mode, pid: process.pid, browserPid: browserServer?.process().pid, observeMs, actualElapsedMs: Date.now() - start, fatal, snapshots, operations, cleanup, forbiddenRequests, externalModelsCalled: false, onlySyntheticProject: true, productionPortUsed: false, forcedClicks: false, sourceMutated: false, purpose: 'Observation, not a passing product QA result' };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); emit('worker-result-written', { resultPath: path.join(directory, 'result.json'), cleanup }); await writeTail;
    if (cleanup.some(item => !item.normalClose)) { emit('owned-tree-cleanup-needed'); await new Promise(() => {}); }
  }
}

async function killOwnedTree(child, reason) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return { requested: false, reason };
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return { requested: true, reason, pid: child.pid, method: 'child.kill' }; }
  return new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
    killer.stdout.on('data', bytes => { text += bytes; }); killer.stderr.on('data', bytes => { text += bytes; });
    killer.on('error', error => resolve({ requested: true, reason, pid: child.pid, error: serializeError(error) })); killer.on('close', code => resolve({ requested: true, reason, pid: child.pid, method: 'taskkill exact diagnostic worker PID tree', code, output: text.slice(0, 4000) }));
  });
}

async function orchestrate() {
  if (output === source || output === path.parse(output).root) throw new Error('Choose a dedicated diagnostic output directory');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Use a new empty diagnostic output directory; prior evidence must not be overwritten or reused');
  const before = {};
  for (const relative of ['package.json', 'public/rhine/index.html', 'integrations/rhinelab-ui/src/main.ts']) { const bytes = await readFile(path.join(source, relative)); before[relative] = digest(bytes); }
  const results = [];
  for (const mode of Object.keys(modes)) {
    const directory = path.join(output, mode); await mkdir(directory, { recursive: true });
    const start = Date.now(), args = [script, '--worker', mode, '--source', source, '--output', output, '--observe-ms', String(observeMs), '--watchdog-ms', String(watchdogMs)];
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    const lifecycle = { mode, pid: child.pid, started: new Date(start).toISOString(), args, watchdogMs, observeMs, browserArgs: modes[mode], finished: false }; await writeFile(path.join(directory, 'external-lifecycle.json'), JSON.stringify(lifecycle, null, 2));
    console.log(JSON.stringify({ kind: 'mode-dispatched', mode, pid: child.pid, watchdogMs, observeMs }));
    let out = '', err = '', cleanupRequested = false;
    child.stdout.on('data', bytes => { out += bytes; if (bytes.toString().includes('owned-tree-cleanup-needed')) cleanupRequested = true; }); child.stderr.on('data', bytes => { err += bytes; });
    let timer, watcher;
    const exited = new Promise(resolve => { child.once('error', error => resolve({ kind: 'spawn-error', error: serializeError(error) })); child.once('close', (code, signal) => resolve({ kind: 'closed', code, signal })); });
    const wall = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'external-watchdog-expired' }), watchdogMs); });
    const requested = new Promise(resolve => { watcher = setInterval(() => { if (cleanupRequested) resolve({ kind: 'worker-cleanup-requested' }); }, 100); });
    const outcome = await Promise.race([exited, wall, requested]); clearTimeout(timer); clearInterval(watcher);
    if (outcome.kind !== 'closed' && outcome.kind !== 'spawn-error') outcome.cleanup = await killOwnedTree(child, outcome.kind);
    const finalExit = await Promise.race([exited, delay(3000).then(() => ({ kind: 'still-running-after-cleanup' }))]);
    await writeFile(path.join(directory, 'stdout.ndjson'), out); await writeFile(path.join(directory, 'stderr.txt'), err);
    let result; try { result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); } catch {}
    const final = { ...lifecycle, finished: true, actualWallMs: Date.now() - start, outcome, finalExit, resultPresent: Boolean(result), resultStatus: result?.status, lastWorkerEvent: out.trim().split(/\r?\n/).at(-1), sourceMutated: false };
    await writeFile(path.join(directory, 'external-lifecycle.json'), JSON.stringify(final, null, 2)); results.push(final); console.log(JSON.stringify({ kind: 'mode-finished', mode, pid: child.pid, actualWallMs: final.actualWallMs, outcome: outcome.kind, resultPresent: final.resultPresent }));
  }
  const observedSource = [];
  for (const [relative, expected] of Object.entries(before)) { const actual = digest(await readFile(path.join(source, relative))); observedSource.push({ path: relative, sha256: actual, unchanged: actual === expected }); }
  const summary = { status: 'diagnostic-finished-not-product-qa', modeCount: results.length, modes: results, source, output, observedSource, models: 0, forcedClicks: false, productionProjectsUsed: false, managedUserPortUsed: false, diagnosticChildTreesOnly: true, sourceMutated: false, note: 'Default, current CPU flags and WebGL-disabled observations are independent. Watchdog or unavailable snapshots are retained as real outcomes.' };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ kind: 'diagnostic-finished', summaryPath: path.join(output, 'summary.json'), modes: results.length, sourceUnchanged: observedSource.every(item => item.unchanged) }));
}

if (values.has('--worker')) await worker(values.get('--worker'));
else await orchestrate();
