/* Derived without logic changes from OpenFilm studio/ui/src/lib/text-look.ts.
 * Source SHA256: c81f6a0e71c8c03d1b52b23ead47552953a8f375f0f9e51e1c8df4d6d81dc2ed
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
 * The library's text component (library/text/text) as the inspector edits it: its words are the `.t` layer's text
 * override, everything else its CSS variables in the clip's `:root` override. A word-art look and each motion own a
 * set of those variables: putting one on takes the last one's off first, so they never mix.
 *
 * Pure: no React, no DOM, so `node --test` runs it.
 */

/** The page's own values, as text.html sets them (what an unset variable reads as). */
export const TEXT_DEFAULTS                                   = {
  '--font': "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
  '--size': '62vh', '--weight': '800', '--color': '#ffffff', '--fill': 'none', '--stroke': '0', '--stroke-color': '#000000',
  '--shadow': 'none', '--glow': 'none', '--box': 'transparent', '--box-pad': '0', '--box-radius': '0', '--spacing': '0.02em',
  '--italic': 'normal', '--align': 'center', '--wrap': 'pre',
  '--in': 'none', '--in-time': '0.5s', '--loop': 'none', '--loop-time': '1.6s', '--out': 'none', '--out-time': '0.4s',
};

/** The words' layer in the page. */
export const WORDS_AT = '.t';
const ROOT = ':root';

/** What a word-art look sets (its size only when it has one: a look keeps the words' size). */
export const LOOK_VARS = ['--font', '--weight', '--color', '--fill', '--stroke', '--stroke-color', '--shadow', '--glow', '--box', '--box-pad', '--box-radius', '--spacing', '--italic'];
/** What each motion sets. */
export const MOTION_VARS = { in: ['--in', '--in-time'], loop: ['--loop', '--loop-time'], out: ['--out', '--out-time'] }         ;
                                                  

                                        
const rootOf = (list                                ) => (list ?? []).find((o) => (o            )?.at === ROOT && (o            ).n === undefined)                        ;

/** The clip's variables, its own over the page's defaults. */
export function textVars(overrides                                )                         {
  return { ...TEXT_DEFAULTS, ...((rootOf(overrides)?.style                                      ) ?? {}) };
}

/** Its words as the clip set them (null: the page's own). */
export function textWords(overrides                                )                {
  const list = (overrides ?? [])              ;
  const own = list.find((o) => o?.at === WORDS_AT && typeof o.text === 'string')
    ?? list.find((o) => typeof o?.at === 'string' && LINE_AT.test(o.at) && typeof o.text === 'string');
  return own ? String(own.text) : null;
}

/* the line of words named another way (by its path, `body > div.stage > div.box > span.t`, as typing in place on the
   picture names a layer): the same words */
const LINE_AT = /(^|[\s>+~])(span)?\.t$/;

/** The overrides with `set` in the `:root` entry and `drop` taken out of it (an entry left empty goes). */
export function withVars(overrides                                , set                        , drop                    = [])             {
  const list = (overrides ?? []).map((o) => ({ ...(o            ) }));
  const at = list.findIndex((o) => o.at === ROOT && o.n === undefined);
  const style                         = { ...((at >= 0 ? list[at] .style                                       : undefined) ?? {}) };
  for (const key of drop) delete style[key];
  Object.assign(style, set);
  if (at >= 0) {
    if (Object.keys(style).length) list[at] = { ...list[at], style };
    else list.splice(at, 1);
  } else if (Object.keys(style).length) list.push({ at: ROOT, style });
  return list;
}

/** A word-art look put on: the last look's variables off, this one's on (its size only if it has one). */
export const withLook = (overrides                                , look                        )             => withVars(overrides, look, LOOK_VARS);

/** A motion put on in its slot (in, loop, out): the slot's last motion off, this one on. */
export const withMotion = (overrides                                , slot            , motion                        )             =>
  withVars(overrides, motion, MOTION_VARS[slot]);

/** The overrides with the words set (empty: back to the page's own). */
export function withWords(overrides                                , words        )             {
  /* one entry holds the words: any other naming the line gives its words up (the later one would win over these) */
  const list = (overrides ?? []).map((o) => ({ ...(o            ) }))
    .map((o) => {
      if (o.at === WORDS_AT || typeof o.at !== 'string' || !LINE_AT.test(o.at) || !('text' in o)) return o;
      const { text: _gone, ...rest } = o;
      return rest;
    })
    .filter((o) => !(typeof o.at === 'string' && (o.at === WORDS_AT || LINE_AT.test(o.at)) && Object.keys(o).length <= ('text' in o ? 2 : 1)));
  const own = list.find((o) => o.at === WORDS_AT);
  if (!words) { if (own) delete own.text; return list; }
  if (own) own.text = words;
  else list.push({ at: WORDS_AT, text: words });
  return list;
}

/** Which of `items` a set of variables is now (each item its own `vars`), or null: what the inspector lights. */
export function currentOf                                             (vars                        , items              , keys                   )           {
  return items.find((item) => item.vars && keys.every((k) => (item.vars [k] ?? TEXT_DEFAULTS[k]) === vars[k])) ?? null;
}
