// Synthetic read-only-to-product diagnostic. Copy this file to a short cloud
// job and run from the repository root; only a fresh diagnostic directory is
// written. No suite, release, user file or destination unlink is performed.
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const options = Object.fromEntries(process.argv.slice(2).map(argument => { const match = /^--(source|root|output|ps5|pwsh)=(.+)$/.exec(argument); if (!match) throw Error('Use --source=repo --output=diagnostic-parent [--ps5=path --pwsh=path].'); return [match[1], match[2]]; }));
const root = await realpath(path.resolve(options.source || options.root || process.cwd())), modulePath = path.join(root, 'lib/atomic-file.mjs');
const productBefore = await readFile(modulePath), sha = bytes => createHash('sha256').update(bytes).digest('hex'), { renameWithRetry } = await import(pathToFileURL(modulePath));
const parent = path.resolve(options.output || path.join(os.tmpdir(), 'gx-cloud-lock-diagnostic')); await mkdir(parent, { recursive: true });
if ((await lstat(parent)).isSymbolicLink()) throw Error('Use an ordinary diagnostic output directory.');
const actualParent = await realpath(parent), runRoot = await mkdtemp(path.join(actualParent, 'run-')), reportPath = path.join(runRoot, 'report.json'), command = promisify(execFile);
const report = { status: 'running', root, runRoot, productHelperSHA256: sha(productBefore), nodeVersion: process.version, platform: process.platform, perScenarioWallLimitMs: 10000, timeoutMeaning: 'A bound on owned synthetic lock children, not an extension of product rename retries.', productModified: false, releaseOrSuiteRun: false, destinationUnlinked: false, externalModels: 0, scenarios: [] };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n'), save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const script = String.raw`param([string]$Target,[int]$HoldMs)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$clock=[Diagnostics.Stopwatch]::StartNew()
function Emit-Phase([string]$Stage) {
  [Console]::WriteLine(([ordered]@{stage=$Stage;childMs=$clock.Elapsed.TotalMilliseconds;utc=[DateTime]::UtcNow.ToString('o');psVersion=$PSVersionTable.PSVersion.ToString();processId=$PID;requestedHoldMs=$HoldMs}|ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$stream=$null
try {
  Emit-Phase 'beforeOpen'
  $stream=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  Emit-Phase 'LOCKED'
  Emit-Phase 'timedSleepBegin'
  Start-Sleep -Milliseconds $HoldMs
  Emit-Phase 'timedSleepEnd'
} catch {
  [Console]::WriteLine(([ordered]@{stage='childError';childMs=$clock.Elapsed.TotalMilliseconds;errorType=$_.Exception.GetType().FullName;message=$_.Exception.Message}|ConvertTo-Json -Compress));[Console]::Out.Flush();exit 2
} finally {
  if($stream){Emit-Phase 'beforeDispose';$stream.Dispose();Emit-Phase 'DISPOSED'}
  Emit-Phase 'childScriptEnd'
}
`;
const scriptPath = path.join(runRoot, 'timed-lock.ps1'); await writeFile(scriptPath, script);
const systemPs = options.ps5 || path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
let pwsh = options.pwsh;
if (!pwsh) { try { pwsh = (await command('where.exe', ['pwsh.exe'], { windowsHide: true, timeout: 2000, encoding: 'utf8' })).stdout.trim().split(/\r?\n/)[0]; } catch {} }
const hosts = [{ name: 'system-powershell5', executable: systemPs }, { name: 'powershell7', executable: pwsh || 'pwsh.exe' }];

async function scenario(host, concurrentReader) {
  const directory = await mkdtemp(path.join(runRoot, host.name + (concurrentReader ? '-reader-' : '-plain-'))), destination = path.join(directory, 'owned-target.json'), source = path.join(directory, 'unique-new.tmp');
  const oldBytes = Buffer.from(JSON.stringify({ value: 'old-complete', text: 'synthetic-only'.repeat(500) })), newBytes = Buffer.from(JSON.stringify({ value: 'new-complete', text: 'synthetic-only'.repeat(500) }));
  await writeFile(destination, oldBytes, { flag: 'wx' }); await writeFile(source, newBytes, { flag: 'wx' });
  const start = performance.now(), row = { host: host.name, executable: host.executable, concurrentReader, holdMs: 700, directory, sourceSHA256: sha(newBytes), originalSHA256: sha(oldBytes), events: [], attempts: [], waits: [], reader: { count: 0, completeOld: 0, completeNew: 0, errors: [] } };
  const event = data => { const entry = { ...data, parentMs: Math.round((performance.now() - start) * 1000) / 1000 }; row.events.push(entry); emit({ scenario: host.name, concurrentReader, ...entry }); };
  let child, exited = false, output = '', stderr = '', resolveAcquired, rejectAcquired, stopReader = false, reader, timedOut = false;
  const acquired = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  let resolveExit; const childExit = new Promise(resolve => resolveExit = resolve);
  const controller = new AbortController();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); event({ stage: 'ownedScenarioTimeout' }); if (child && !exited) child.kill(); rejectAcquired(Error('Synthetic child acquisition exceeded10s')); }, 10000);
  try {
    child = spawn(host.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Target', destination, '-HoldMs', '700'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Arguments are separate values; no shell quoting or command evaluation.
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); let newline; while ((newline = output.indexOf('\n')) >= 0) { const line = output.slice(0, newline).trim(); output = output.slice(newline + 1); if (!line) continue; try { const phase = JSON.parse(line); event({ stage: 'childPhase', phase }); if (phase.stage === 'LOCKED') resolveAcquired(); } catch { event({ stage: 'unparsedStdout', text: line.slice(0, 1000) }); } } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.once('error', error => { event({ stage: 'childSpawnError', code: error.code, message: error.message }); rejectAcquired(error); resolveExit(); });
    child.once('exit', (code, signal) => { exited = true; row.childExit = { code, signal }; event({ stage: 'childExit', code, signal }); rejectAcquired(Error('Child exited before lock acquisition if no LOCKED phase preceded this event.')); resolveExit(); });
    await acquired; event({ stage: 'parentRenameStart' });
    if (concurrentReader) reader = (async () => { while (!stopReader) { try { const bytes = await readFile(destination); row.reader.count++; if (bytes.equals(oldBytes)) row.reader.completeOld++; else if (bytes.equals(newBytes)) row.reader.completeNew++; else row.reader.errors.push({ code: 'PARTIAL_BYTES', elapsedMs: performance.now() - start }); } catch (error) { row.reader.errors.push({ code: error.code, elapsedMs: performance.now() - start }); } await pause(5); } })();
    try {
      await renameWithRetry(source, destination, { signal: controller.signal,
        renameOperation: async (from, to) => { const attempt = { number: row.attempts.length + 1, startedMs: performance.now() - start }; try { await rename(from, to); attempt.result = 'committed'; event({ stage: 'renameCommitted', attempt: attempt.number }); } catch (error) { Object.assign(attempt, { code: error.code, errno: error.errno, syscall: error.syscall }); throw error; } finally { attempt.finishedMs = performance.now() - start; row.attempts.push(attempt); emit({ scenario: host.name, concurrentReader, stage: 'renameAttempt', ...attempt }); } },
        wait: async (delay, value, options) => { const wait = { scheduledMs: delay, startedMs: performance.now() - start }; try { await pause(delay, value, options); } finally { wait.finishedMs = performance.now() - start; row.waits.push(wait); } },
      }); row.outcome = 'committed';
    } catch (error) { row.outcome = 'rename-rejected'; row.error = { name: error.name, code: error.code, errno: error.errno, syscall: error.syscall, message: error.message }; event({ stage: 'renameRejected', ...row.error }); }
    finally { stopReader = true; await reader; }
    const primaryBytes = await readFile(destination); row.targetAfterPrimarySHA256 = sha(primaryBytes); row.originalBytesPreservedAfterPrimaryFailure = row.outcome === 'rename-rejected' ? primaryBytes.equals(oldBytes) : null;
    await childExit;
    if (!timedOut && row.outcome === 'rename-rejected') {
      // One independent actual rename after the child has exited distinguishes
      // an expired retry budget from an additional persistent path/file issue.
      try { await rename(source, destination); row.afterChildExitProbe = 'committed'; event({ stage: 'afterChildExitRenameCommitted' }); }
      catch (error) { row.afterChildExitProbe = { code: error.code, errno: error.errno, syscall: error.syscall }; event({ stage: 'afterChildExitRenameRejected', ...row.afterChildExitProbe }); }
    }
  } catch (error) { row.outcome ||= 'diagnostic-setup-failed'; row.setupError = { name: error.name, code: error.code, message: error.message }; }
  finally {
    stopReader = true; await reader; if (child && !exited) { child.kill(); await childExit; } clearTimeout(timer);
    row.timedOut = timedOut; row.stderr = stderr; row.totalMs = performance.now() - start;
    try { const final = await readFile(destination); row.finalTargetSHA256 = sha(final); row.finalBytesComplete = final.equals(oldBytes) || final.equals(newBytes); row.originalPreservedOnRejectedRename = row.outcome !== 'rename-rejected' ? null : row.attempts.every(attempt => attempt.result !== 'committed'); } catch (error) { row.finalReadError = error.code; }
  }
  const locked = row.events.find(item => item.phase?.stage === 'LOCKED'), disposed = row.events.find(item => item.phase?.stage === 'DISPOSED');
  row.actualChildLockedToDisposedMs = locked && disposed ? disposed.phase.childMs - locked.phase.childMs : null;
  report.scenarios.push(row); await save(); emit({ stage: 'scenarioSummary', host: host.name, concurrentReader, outcome: row.outcome, actualChildLockedToDisposedMs: row.actualChildLockedToDisposedMs, totalMs: row.totalMs, timedOut });
}

for (const host of hosts) for (const reader of [false, true]) await scenario(host, reader);
if (sha(await readFile(modulePath)) !== report.productHelperSHA256) throw Error('Product helper changed during diagnostic.');
report.status = 'completed-diagnostic'; report.productHelperUnchanged = true; report.finishedAt = new Date().toISOString(); await save(); emit({ status: report.status, report: reportPath, scenarios: report.scenarios.length, productHelperUnchanged: true, remoteActions: 0, userDataTouched: false });
