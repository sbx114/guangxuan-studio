/** Reusable motion mathematics, without scene, theme, layout or React templates.
 * Velocity integration adapts WhipBrakeReal by Wei Yihao, Apache-2.0:
 * https://github.com/Vincentwei1021/video-shotcraft/blob/075b548c2405a07b77129eb448b0b504fc60dea3/demos/transition/shot-transitions/WhipBrakeReal.tsx
 * Shared source-space camera coordinates adapt PageCam from the same revision.
 * Arc-length trajectory mapping and phase helpers are Gx adaptations.
 */
export function clamp01(value) { return Math.max(0, Math.min(1, value)); }
export function smooth01(value) { const p = clamp01(value); return p * p * (3 - 2 * p); }

export function makeSpeedTrack({ durationFrames = 60, launchFrames = 3, decay = 6, brakeFraction = .85, samplesPerFrame = 8 } = {}) {
  const duration = Math.max(1, Number(durationFrames) || 60), step = 1 / Math.max(1, Math.min(32, Number(samplesPerFrame) || 8));
  const count = Math.ceil(duration / step), table = new Float64Array(count + 1);
  const launch = Math.max(step, Number(launchFrames) || 3), brake = Math.max(.2, Math.min(.99, Number(brakeFraction) || .85));
  const velocity = time => Math.exp(-Math.max(0, decay) * time / duration) * smooth01(time / launch) * (1 - smooth01((time / duration - brake) / (1 - brake)));
  for (let i = 1; i <= count; i++) {
    const a = (i - 1) * step, b = Math.min(duration, i * step);
    table[i] = table[i - 1] + (velocity(a) + velocity(b)) * (b - a) / 2;
  }
  const total = table[count];
  for (let i = 0; i <= count; i++) table[i] /= total || 1;
  return { duration, step, table };
}
export function speedProgressAt(track, frame) {
  if (frame <= 0) return 0;
  if (frame >= track.duration) return 1;
  const at = frame / track.step, i = Math.min(track.table.length - 2, Math.floor(at));
  return track.table[i] + (track.table[i + 1] - track.table[i]) * (at - i);
}
export function bezierPoint(points, progress) {
  const p = clamp01(progress), work = points.map(point => ({ x: point.x, y: point.y }));
  for (let n = work.length - 1; n > 0; n--) for (let i = 0; i < n; i++) work[i] = { x: work[i].x * (1 - p) + work[i + 1].x * p, y: work[i].y * (1 - p) + work[i + 1].y * p };
  return work[0] || { x: 0, y: 0 };
}
export function makePathTrack(points, samples = 160) {
  const count = Math.max(8, Math.min(4096, Math.round(samples))), path = [], lengths = [0];
  for (let i = 0; i <= count; i++) {
    const point = bezierPoint(points, i / count); path.push(point);
    if (i) lengths.push(lengths[i - 1] + Math.hypot(point.x - path[i - 1].x, point.y - path[i - 1].y));
  }
  return { points: path, lengths, length: lengths.at(-1) };
}
export function pathPointAt(track, progress) {
  const distance = clamp01(progress) * track.length;
  if (distance <= 0) return { ...track.points[0] };
  if (distance >= track.length) return { ...track.points.at(-1) };
  let low = 0, high = track.lengths.length - 1;
  while (high - low > 1) { const middle = (low + high) >> 1; if (track.lengths[middle] < distance) low = middle; else high = middle; }
  const p = (distance - track.lengths[low]) / Math.max(1e-12, track.lengths[high] - track.lengths[low]);
  return { x: track.points[low].x + (track.points[high].x - track.points[low].x) * p, y: track.points[low].y + (track.points[high].y - track.points[low].y) * p };
}
export function trajectoryStateAt(path, track, frame, { startFrame = 0, tailFrames = 8, tailSamples = 7 } = {}) {
  const local = frame - startFrame, position = offset => pathPointAt(path, speedProgressAt(track, local + offset));
  const head = position(0), before = position(-.5), after = position(.5), velocity = local >= track.duration ? { x: 0, y: 0 } : { x: after.x - before.x, y: after.y - before.y };
  const speed = Math.hypot(velocity.x, velocity.y), count = Math.max(2, Math.min(32, Math.round(tailSamples)));
  const trail = Array.from({ length: count }, (_, i) => ({ ...position(-tailFrames * (count - 1 - i) / (count - 1)), alpha: (i + 1) / count }));
  return { head, velocity, speed, progress: speedProgressAt(track, local), arrived: local >= track.duration, trail, trailWeight: clamp01(speed / Math.max(1, path.length / track.duration)) };
}
export function worldToScreen(point, camera, { width, height, depth = 1, origin = { x: width / 2, y: height / 2 } } = {}) {
  const zoom = 1 + ((camera.zoom ?? 1) - 1) * depth;
  const cx = origin.x + (camera.cx - origin.x) * depth, cy = origin.y + (camera.cy - origin.y) * depth;
  return { x: width / 2 + (point.x - cx) * zoom, y: height / 2 + (point.y - cy) * zoom, scale: zoom };
}
export function cameraAt(frame, keys) {
  if (frame <= keys[0].frame) return { ...keys[0] };
  if (frame >= keys.at(-1).frame) return { ...keys.at(-1) };
  const index = keys.findIndex((key, i) => i < keys.length - 1 && frame >= key.frame && frame <= keys[i + 1].frame);
  const a = keys[index], b = keys[index + 1], p = smooth01((frame - a.frame) / (b.frame - a.frame));
  return { cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, zoom: (a.zoom ?? 1) + ((b.zoom ?? 1) - (a.zoom ?? 1)) * p };
}
export function shotTimingFrames(shot, fps) {
  const frame = seconds => Math.round(seconds * fps), start = frame(shot.start), end = frame(shot.end);
  const actionEnd = frame(Number.isFinite(shot.actionEnd) ? shot.actionEnd : shot.hold?.start ?? shot.end);
  const holdStart = frame(Number.isFinite(shot.hold?.start) ? shot.hold.start : actionEnd / fps);
  const holdEnd = Math.min(end, holdStart + frame(Math.max(0, shot.hold?.duration || 0)));
  const transitionStart = Math.max(start, end - frame(Math.max(0, shot.transition?.duration || 0)));
  return { start, end, actionEnd: Math.max(start, Math.min(end, actionEnd)), holdStart, holdEnd, transitionStart };
}

const functions = [clamp01, smooth01, makeSpeedTrack, speedProgressAt, bezierPoint, makePathTrack, pathPointAt, trajectoryStateAt, worldToScreen, cameraAt, shotTimingFrames];
export const DIRECTING_MOTION_SOURCE = '/* Gx reusable motion helpers. Adapted WhipBrake velocity integration and PageCam source-space coordinates. Wei Yihao, Apache-2.0, video-shotcraft commit 075b548c2405a07b77129eb448b0b504fc60dea3. Independent arc-length/time helpers; no scene or theme preset. */\n' + functions.map(fn => 'export ' + fn.toString()).join('\n\n');
