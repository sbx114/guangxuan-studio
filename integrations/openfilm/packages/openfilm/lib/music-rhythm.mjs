// Local PCM rhythm evidence. No model, filenames, catalog BPM or supplied beat
// grid participates. Times refer to the analyzed source; meter/downbeat is not
// inferred. Scores are evidence measures, not calibrated probabilities.
const RATE = 22050, HOP = 128, WINDOW = 512;
const clamp = value => Math.max(0, Math.min(1, value));
const ms = value => Math.round(value * 1000) / 1000;
const quantile = (values, p) => { const sorted = Array.from(values).sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0; };
const median = values => quantile(values, .5);

function magnitudes(values) {
  const re = Float64Array.from(values), im = new Float64Array(values.length), n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j], re[i]]; }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    for (let at = 0; at < n; at += size) for (let k = 0; k < size / 2; k++) {
      const cos = Math.cos(angle * k), sin = Math.sin(angle * k), a = at + k, b = a + size / 2;
      const xr = re[b] * cos - im[b] * sin, xi = re[b] * sin + im[b] * cos;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
  return Float64Array.from({ length: n / 2 }, (_, k) => Math.log1p(30 * Math.hypot(re[k], im[k])));
}

function onsetsOf(samples) {
  const count = Math.ceil(samples.length / HOP), novelty = new Float64Array(count), rms = new Float64Array(count);
  const window = Float64Array.from({ length: WINDOW }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (WINDOW - 1)));
  let previous = new Float64Array(WINDOW / 2);
  for (let frame = 0; frame < count; frame++) {
    const start = frame * HOP - WINDOW / 2, values = new Float64Array(WINDOW); let energy = 0;
    for (let i = 0; i < WINDOW; i++) { const value = samples[start + i] || 0; values[i] = value * window[i]; energy += value * value; }
    rms[frame] = Math.sqrt(energy / WINDOW); const spectrum = magnitudes(values); let flux = 0;
    for (let k = 1; k < spectrum.length; k++) flux += Math.max(0, spectrum[k] - previous[k]);
    novelty[frame] = flux / spectrum.length + 4 * Math.max(0, rms[frame] - (rms[frame - 1] || 0)); previous = spectrum;
  }
  let maximum = 0; for (const value of novelty) maximum = Math.max(maximum, value);
  const radius = Math.round(.25 * RATE / HOP), picked = [];
  if (maximum < .003) return [];
  for (let frame = 0; frame < count; frame++) {
    const value = novelty[frame];
    if (value < Math.max(.003, maximum * .04) || frame && value < novelty[frame - 1] || frame + 1 < count && value <= novelty[frame + 1]) continue;
    const local = novelty.subarray(Math.max(0, frame - radius), Math.min(count, frame + radius + 1)), floor = median(local), mad = median(Array.from(local, x => Math.abs(x - floor)));
    if (value < floor + 3 * mad + .003) continue;
    // Refine the FFT peak against the actual PCM envelope. This corrects the
    // analysis-window lookahead; it never snaps onsets onto a tempo grid.
    const center = frame * HOP, lo = Math.max(0, center - WINDOW), hi = Math.min(samples.length, center + WINDOW / 2), step = Math.max(1, Math.round(RATE * .001));
    const envelope = []; for (let start = lo; start < hi; start += step) { let sum = 0; for (let i = start; i < Math.min(hi, start + step); i++) sum += samples[i] * samples[i]; envelope.push({ at: start, value: Math.sqrt(sum / step) }); }
    const peak = Math.max(0, ...envelope.map(item => item.value)), base = quantile(envelope.slice(0, Math.max(1, Math.floor(envelope.length / 4))).map(item => item.value), .3), threshold = base + .15 * Math.max(0, peak - base);
    const attack = envelope.find(item => item.value >= threshold && item.value > base + .0003);
    const time = (attack?.at ?? center) / RATE, strength = clamp(value / Math.max(maximum, .001));
    if (picked.length && time - picked.at(-1).time < .07) { if (strength > picked.at(-1).strength) picked[picked.length - 1] = { time, strength }; }
    else picked.push({ time, strength });
  }
  return picked;
}

function gridScore(onsets, period, phase) {
  const tolerance = Math.min(.055, period * .13), occupied = new Set(); let total = 0, matched = 0, subdivision = 0;
  for (const onset of onsets) {
    const weight = .45 + .55 * Math.sqrt(onset.strength), position = (onset.time - phase) / period, index = Math.round(position), distance = Math.abs(position - index) * period;
    total += weight;
    if (distance <= tolerance) { matched += weight * Math.exp(-.5 * (distance / (tolerance / 2)) ** 2); occupied.add(index); }
    else if (Math.abs(position * 2 - Math.round(position * 2)) * period / 2 <= tolerance) subdivision += weight;
  }
  const first = Math.ceil((onsets[0].time - phase - tolerance) / period), last = Math.floor((onsets.at(-1).time - phase + tolerance) / period), gridCount = Math.max(1, last - first + 1);
  const support = matched / Math.max(total, .001), coverage = occupied.size / gridCount;
  return { score: clamp(.5 * support + .5 * coverage + .035 * subdivision / Math.max(total, .001)), support, coverage };
}

function tempoCandidates(onsets) {
  const anchors = [...onsets].sort((a, b) => b.strength - a.strength).slice(0, 24), scored = [];
  for (let bpm = 40; bpm <= 220; bpm++) {
    const period = 60 / bpm; let best = { score: -1, phase: 0 };
    for (const anchor of anchors) {
      let phase = anchor.time % period;
      // Mean residual of actual matching attacks refines the phase without
      // assigning unsupported leading/trailing beats.
      for (let pass = 0; pass < 2; pass++) { const residual = onsets.map(onset => { const position = (onset.time - phase) / period; return onset.time - (phase + Math.round(position) * period); }).filter(value => Math.abs(value) < Math.min(.04, period * .1)); if (residual.length) phase += residual.reduce((a, b) => a + b, 0) / residual.length; }
      const value = gridScore(onsets, period, phase);
      if (value.score > best.score) best = { ...value, phase, bpm, period };
    }
    scored.push(best);
  }
  // When half/double-time grids explain the same evidence, prefer the one
  // supported by more actual attacks, while preserving both interpretations
  // and an uncertain status. A small tie-break never overrides clear coverage.
  scored.sort((a, b) => (b.score + .01 * b.support) - (a.score + .01 * a.support));
  const selected = [];
  for (const item of scored) if (selected.every(other => Math.abs(Math.log(item.bpm / other.bpm)) > .045)) { selected.push(item); if (selected.length === 6) break; }
  return selected;
}

function trackBeats(onsets, candidate) {
  const n = onsets.length, scores = new Float64Array(n), periods = new Float64Array(n), previous = new Int32Array(n).fill(-1), steps = new Int8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const phaseDistance = Math.abs((onsets[i].time - candidate.phase) / candidate.period - Math.round((onsets[i].time - candidate.phase) / candidate.period)) * candidate.period;
    const reward = 1 + .35 * onsets[i].strength + .4 * Math.exp(-.5 * (phaseDistance / .04) ** 2);
    scores[i] = reward; periods[i] = candidate.period;
    for (let j = i - 1; j >= 0 && onsets[i].time - onsets[j].time <= candidate.period * 4.5; j--) {
      const gap = onsets[i].time - onsets[j].time, k = Math.max(1, Math.round(gap / periods[j])); if (k > 4) continue;
      const localPeriod = gap / k, change = Math.log(localPeriod / periods[j]); if (Math.abs(change) > .4) continue;
      const cost = .6 * (change / .2) ** 2 + .25 * (k - 1) + .08 * (Math.log(localPeriod / candidate.period) / .3) ** 2;
      const score = scores[j] + reward - cost;
      if (score > scores[i]) { scores[i] = score; previous[i] = j; periods[i] = .75 * periods[j] + .25 * localPeriod; steps[i] = k; }
    }
  }
  let last = 0; for (let i = 1; i < n; i++) if (scores[i] > scores[last]) last = i;
  const path = []; for (let at = last; at >= 0; at = previous[at]) path.unshift(at);
  const beats = [], intervals = [];
  for (let p = 0; p < path.length; p++) {
    const onset = onsets[path[p]];
    if (p) {
      const before = onsets[path[p - 1]], k = steps[path[p]], interval = (onset.time - before.time) / k; intervals.push(interval);
      for (let sub = 1; sub < k; sub++) beats.push({ time: before.time + sub * interval, strength: 0, confidence: .35 * candidate.score, inferred: true });
    }
    beats.push({ time: onset.time, strength: onset.strength, confidence: clamp(candidate.score * (.6 + .4 * onset.strength)), inferred: false });
  }
  return { beats, intervals, observedCount: path.length };
}

/** Actual PCM evidence. Interpolated missing pulses are marked inferred. */
export function analyzeRhythm(samples, sampleRate, { offsetSeconds = 0 } = {}) {
  if (!(samples instanceof Float32Array)) throw new TypeError('Rhythm analysis needs Float32Array PCM samples.');
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) throw new RangeError('PCM sample rate must be between 4000 and 192000 Hz.');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw new RangeError('Source offset must be finite and non-negative.');
  let peak = 0, energy = 0; for (const sample of samples) { if (!Number.isFinite(sample)) throw new TypeError('PCM samples must be finite.'); peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
  const duration = samples.length / sampleRate, coverage = { start: ms(offsetSeconds), end: ms(offsetSeconds + duration) }, warnings = [];
  const base = { version: 1, method: 'pcm-spectral-flux-rms-phase-dp-v1', status: 'no-beat', duration: ms(duration), bpm: null, tempoConfidence: 0, tempoCandidates: [], beats: [], onsets: [], coverage, warnings };
  if (duration < 4) warnings.push('Short analysis window: tempo and phase evidence may be insufficient.');
  if (peak < .00001 || samples.length < 512) return base;
  const count = Math.round(duration * RATE), normalized = new Float32Array(count);
  for (let i = 0; i < count; i++) { const at = i * sampleRate / RATE, lo = Math.floor(at), mix = at - lo; normalized[i] = (samples[lo] || 0) * (1 - mix) + (samples[lo + 1] || 0) * mix; }
  const onsets = onsetsOf(normalized); base.onsets = onsets.map(onset => ({ time: ms(offsetSeconds + onset.time), strength: ms(onset.strength) }));
  if (onsets.length < 4 || onsets.at(-1).time - onsets[0].time < 1.5) return base;
  const candidates = tempoCandidates(onsets), best = candidates[0], runner = candidates[1], margin = Math.max(0, best.score - (runner?.score || 0));
  base.tempoCandidates = candidates.map(item => ({ bpm: item.bpm, score: ms(item.score) }));
  if (best.score < .42) { base.status = 'uncertain'; warnings.push('Detected attacks do not support a stable beat grid.'); return base; }
  const tracked = trackBeats(onsets, best), period = median(tracked.intervals) || best.period, variation = tracked.intervals.length ? (quantile(tracked.intervals, .9) - quantile(tracked.intervals, .1)) / period : 1;
  const inferredFraction = tracked.beats.filter(beat => beat.inferred).length / Math.max(1, tracked.beats.length), spanCoverage = tracked.beats.length ? (tracked.beats.at(-1).time - tracked.beats[0].time) / Math.max(.001, onsets.at(-1).time - onsets[0].time) : 0;
  const confidence = clamp(best.score * (.55 + .45 * Math.min(1, margin / .12)) * spanCoverage * (1 - inferredFraction * .4));
  base.bpm = Math.round(60 / period * 10) / 10; base.tempoConfidence = ms(confidence);
  base.status = confidence >= .65 && best.score >= .7 && inferredFraction <= .35 && variation <= .14 && duration >= 4 ? 'ready' : 'uncertain';
  if (margin < .065) { warnings.push('Competing tempo interpretations: do not treat the grid as an automatic cutting instruction.'); base.status = 'uncertain'; }
  if (variation > .14) { warnings.push('Tempo changes or irregular spacing were detected; review local beat timing.'); base.status = 'uncertain'; }
  if (inferredFraction > 0) warnings.push('Some missing pulses were interpolated between observed attacks and marked inferred.');
  if (peak < .006 || Math.sqrt(energy / Math.max(1, samples.length)) < .0003) { warnings.push('Low-level PCM: beat evidence is weak.'); base.status = 'uncertain'; }
  base.beats = tracked.beats.map(beat => ({ time: ms(offsetSeconds + beat.time), strength: ms(beat.strength), confidence: ms(beat.confidence * (base.status === 'ready' ? 1 : .65)), inferred: beat.inferred }));
  warnings.push('No meter or downbeat is inferred. Beat scores are evidence estimates, not calibrated probabilities.');
  return base;
}
