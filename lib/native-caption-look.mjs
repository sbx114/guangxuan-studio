/* Derived without logic changes from OpenFilm studio/ui/src/lib/caption-look.ts.
 * Source SHA256: 6eccc023b11e07f07f87b66bf12643e04277c8043e1e40b58d7f9ec8f84e6b21
 * Types removed with Node stripTypeScriptTypes; no UI runtime dependency.
 * MIT License
 * 
 * Copyright (c) 2026 OpenFilm contributors
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * 
 */
/**
 * A caption's look as the library text's variables (lib/text-look): what the caption renderer styles a cue's words by
 * (src/captions.mjs CAPTION_BASE_CSS), read from a STYLE rule's own variables, else from its plain CSS (a look from
 * before: `font`, `color`…), which is given up for them once the look is changed.
 *
 * Plain TypeScript, no React: the editor's tests import it as it is.
 */
import { LOOK_VARS, TEXT_DEFAULTS } from './native-text-look.mjs';
import { cueRule } from './native-caption-edits.mjs';
import { readVtt } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';

/** A caption as the renderer draws it with nothing said (CAPTION_BASE_CSS), in the text's variables. */
export const CAPTION_DEFAULTS                         = {
  ...TEXT_DEFAULTS,
  '--font': 'sans-serif', '--size': '5cqmin', '--weight': '400', '--color': '#ffffff', '--box': 'rgba(0, 0, 0, 0.8)', '--box-pad': '0 0.25em',
  '--spacing': 'normal', '--in': 'none', '--in-time': '0.5s', '--loop': 'none', '--out': 'none',
};
/** The plain CSS a look from before may say, given up for the variables once the look is changed. */
export const PLAIN = ['font', 'font-family', 'font-size', 'font-weight', 'font-style', 'color', 'background', 'background-color', '-webkit-text-stroke',
  'paint-order', 'text-shadow', 'letter-spacing', 'padding', 'border-radius', 'filter', 'animation', 'display'];

/** A rule's look as the text's variables: its own, else read from its plain CSS. */
export function varsOf(rule                        )                         {
  const out                         = {};
  const font = rule.font ?? '';
  const size = rule['font-size'] ?? /([\d.]+cqmin|[\d.]+cqh)/.exec(font)?.[1];
  const weight = rule['font-weight'] ?? /^(?:italic\s+)?(\d{3}|bold)\b/.exec(font)?.[1];
  const family = rule['font-family'] ?? /(?:cqmin|cqh|px|em)(?:\/[\d.]+)?\s+(.+)$/.exec(font)?.[1];
  const stroke = /^([\d.]+em)\s+(.+)$/.exec(rule['-webkit-text-stroke'] ?? '');
  const bg = rule.background ?? rule['background-color'];
  if (size) out['--size'] = size;
  if (weight) out['--weight'] = weight === 'bold' ? '700' : weight;
  if (family) out['--font'] = family;
  if (rule.color) out['--color'] = rule.color;
  if (stroke) { out['--stroke'] = stroke[1] ; out['--stroke-color'] = stroke[2] ; }
  if (rule['text-shadow']) out['--shadow'] = rule['text-shadow'];
  if (bg) out['--box'] = bg === 'none' ? 'transparent' : bg;
  if (rule.padding) out['--box-pad'] = rule.padding;
  if (rule['border-radius']) out['--box-radius'] = rule['border-radius'];
  if (rule['letter-spacing']) out['--spacing'] = rule['letter-spacing'];
  for (const [k, v] of Object.entries(rule)) if (k.startsWith('--')) out[k] = v;
  return out;
}
/* the inspector's size (a % of a text's box: `62vh`) and a caption's (a share of the frame's short side) */
export const toInspector = (size        ) => { const n = Number.parseFloat(size); return Number.isFinite(n) ? `${Math.round(n * 100) / 10}vh` : size; };
export const fromInspector = (size        ) => { const n = Number.parseFloat(size); return Number.isFinite(n) ? `${Math.round(n * 10) / 100}cqmin` : size; };


/** A caption's size, a share of the frame's short side (cqmin), as a rule says it (null: it says none). */
export function sizeOf(rule                        )                {
  const n = Number.parseFloat(varsOf(rule)['--size'] ?? '');
  return Number.isFinite(n) ? n : null;
}

/** The declarations that set `set` on a rule as the variables, its look so far kept as them and its plain CSS taken away. */
export function lookDecls(rule                        , set                        )                                {
  const out                                = { ...varsOf(rule), ...set };
  for (const p of PLAIN) out[p] = null;
  return out;
}

/** A caption look's `::cue` rule (plain CSS, as film-subtitle's looks are written) as the text's variables. */
export function lookVars(css        )                         {
  return varsOf(cueRule(readVtt(`WEBVTT\n\nSTYLE\n${css}\n`), '::cue'));
}

/** What a look sets on a caption: each of a look's variables, a caption's own default where it says none (its size not). */
export function captionLookSet(vars                                  )                         {
  return Object.fromEntries(LOOK_VARS.map((k) => [k, vars[k] ?? CAPTION_DEFAULTS[k] ?? TEXT_DEFAULTS[k] ]));
}
