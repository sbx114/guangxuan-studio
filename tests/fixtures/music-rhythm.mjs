// Authored PCM groundtruth for DSP validation. These times are never supplied
// to analyzeRhythm(). Different instruments, sample rates and non-grid events
// avoid merely mirroring the detector's feature extraction.
export function makePcm({ duration = 20, sampleRate = 22050, beats = [], events = beats.map(time => ({ time })), noise = 0, seed = 4242 } = {}) {
  const samples = new Float32Array(Math.round(duration * sampleRate)); let random = seed >>> 0;
  if (noise) for (let i = 0; i < samples.length; i++) { random = (1664525 * random + 1013904223) >>> 0; samples[i] = noise * (random / 2 ** 31 - 1); }
  for (const event of events) {
    const start = Math.round(event.time * sampleRate), amplitude = event.amplitude ?? .6, frequency = event.frequency ?? 880, length = Math.round(sampleRate * .05);
    for (let i = 0; i < length && start + i < samples.length; i++) if (start + i >= 0) samples[start + i] += amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate) * Math.exp(-i / (sampleRate * .009));
  }
  return { samples, sampleRate, duration, beats, events };
}
export function grid(bpm, duration, offset = .17) {
  const times = []; for (let index = 0, time = offset; time < duration - .07; time = offset + ++index * 60 / bpm) times.push(time); return times;
}
export function rhythmScenarios() {
  const regular = [60, 90, 120, 150].map(bpm => ({ id: 'regular-' + bpm, bpm, ...makePcm({ beats: grid(bpm, 20) }) }));
  const beat = grid(120, 24, .237);
  const accents = beat.map((time, index) => ({ time, amplitude: index % 4 ? .14 : .7, frequency: index % 4 ? 1400 : 550 }));
  const sync = beat.map((time, index) => ({ time: index % 4 === 1 ? time + .25 : time, amplitude: .6, frequency: 1300 }));
  const incidental = [{ time: 2.913, amplitude: .16, frequency: 2300 }, { time: 6.831, amplitude: .13, frequency: 1700 }, { time: 12.079, amplitude: .18, frequency: 2100 }];
  const changing = [...grid(120, 6.1, .17), ...grid(150, 7.9, .17).map(time => time + 6)];
  let cursor = .15; const irregular = []; for (const delta of [.21, .71, .38, .84, .19, .53, .91, .27, .64, .33, .78, .43, .16, .69, .87, .25, .58, .35, .82, .47]) { cursor += delta; irregular.push(cursor); }
  return [...regular,
    { id: 'accented-120', bpm: 120, ...makePcm({ duration: 24, beats: beat, events: accents }) },
    { id: 'syncopated-120', bpm: 120, ...makePcm({ duration: 24, beats: beat, events: sync }) },
    { id: 'noise-and-off-grid-attacks', bpm: 120, ...makePcm({ duration: 24, beats: beat, noise: .009, events: [...beat.map(time => ({ time, frequency: 700 })), ...incidental].sort((a, b) => a.time - b.time) }) },
    { id: 'tempo-change', bpm: null, varying: true, ...makePcm({ duration: 14, beats: changing }) },
    { id: 'weak-120', bpm: 120, ...makePcm({ duration: 20, beats: grid(120, 20), events: grid(120, 20).map(time => ({ time, amplitude: .003 })) }) },
    { id: 'irregular-attacks', bpm: null, ...makePcm({ duration: 12, beats: [], events: irregular.map(time => ({ time })) }) },
    { id: 'unmodulated-noise', bpm: null, ...makePcm({ duration: 20, noise: .04 }) },
  ];
}
