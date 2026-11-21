/* Derived without logic changes from OpenFilm studio/ui/src/lib/html-source.ts.
 * Source SHA256: 1eb302e9c590ad1d064b1b9e433807552052d8066761a5f84dd7fc675b1cb5fa
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
 * A page's HTML read as its file has it: each element with where it starts and ends in the text, its attributes and
 * its words, so Studio can write into a page (lib/layer-paste) and leave every other character as it was. The
 * browser's own reading (DOMParser) says which element is which; this says where it is.
 *
 * It reads what people and agents write: elements, attributes quoted or not, comments, raw text (`<script>`,
 * `<style>`, `<textarea>`, `<title>`), elements that hold nothing (`<br>`, `<img>` …, or `/>` in SVG), the end tags a
 * page may leave out (`</p>` before a block, `</li>`, `</td>` …) and the `<tbody>` rows written in a table are read in.
 * What it cannot tell apart is caught by comparing its tree with the browser's (sameShape).
 *
 * Pure: no DOM, so `node --test` runs it.
 */

                             
               
                                                  
                       
                                                             
                
              
 

                                                                        

                                
                  
                    
              
                 
                
                                                                                        
                 
                                                                          
                  
                                        
                  
                                                      
                     
                                                                
              
                      
                                           
 

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/* not `<noscript>`: a page read without its scripts (DOMParser, a render) reads what is in it as elements. A
   `<template>`'s are not its elements either (they are its content): held as text, as the browser has none */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'template']);
/** Where `/>` ends an element: inside SVG and MathML. In HTML it is ignored (`<div/>` is an open `<div>`). */
const FOREIGN = new Set(['svg', 'math']);
/** Elements a `<p>` left open ends before. */
const ENDS_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
/** An element ended by the start of another of these, when it is the one open. */
const ENDS_SELF                                    = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option', 'optgroup'], tr: ['tr'], td: ['td', 'th', 'tr'], th: ['td', 'th', 'tr'],
};

/** The page's elements as its file has them, in a root that holds the top ones. */
export function readSource(text        )                {
  const root                = { kind: 'element', tag: '#root', start: 0, nameEnd: 0, openEnd: 0, closeStart: text.length, end: text.length, attrs: [], children: [] };
  const open                  = [root];
  const top = () => open[open.length - 1] ;
  const close = (el               , at        , end        ) => { el.closeStart = at; el.end = end; };
  let i = 0;
  let textFrom = 0;
  const flushText = (to        ) => { if (to > textFrom) top().children.push({ kind: 'text', start: textFrom, end: to }); };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      flushText(lt);
      const endAt = text.indexOf('-->', lt + 4);
      i = textFrom = endAt < 0 ? text.length : endAt + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      flushText(lt);
      const gt = text.indexOf('>', lt);
      i = textFrom = gt < 0 ? text.length : gt + 1;
      continue;
    }
    const endTag = /^<\/([A-Za-z][\w:-]*)[^>]*>/.exec(text.slice(lt, lt + 200));
    if (endTag) {
      flushText(lt);
      const tag = endTag[1] .toLowerCase();
      const k = open.map((e) => e.tag).lastIndexOf(tag);
      if (k > 0) {
        /* the ones opened inside it and left open end here too */
        for (let j = open.length - 1; j > k; j--) close(open[j] , lt, lt);
        close(open[k] , lt, lt + endTag[0].length);
        open.length = k;
      }
      i = textFrom = lt + endTag[0].length;
      continue;
    }
    const name = /^<([A-Za-z][\w:-]*)/.exec(text.slice(lt, lt + 100));
    if (!name) { i = lt + 1; continue; }
    flushText(lt);
    const tag = name[1] .toLowerCase();
    const nameEnd = lt + name[0].length;
    const { attrs, end: openEnd, selfClosed } = readAttrs(text, nameEnd);
    /* end tags a page may leave out */
    if (ENDS_P.has(tag) && top().tag === 'p') { close(top(), lt, lt); open.pop(); }
    const ends = ENDS_SELF[top().tag];
    if (ends?.includes(tag)) { close(top(), lt, lt); open.pop(); }
    /* rows written straight in a table are read inside a <tbody> */
    if (tag === 'tr' && top().tag === 'table') {
      const body                = { kind: 'element', tag: 'tbody', implied: true, start: lt, nameEnd: lt, openEnd: lt, closeStart: lt, end: lt, attrs: [], children: [] };
      top().children.push(body);
      open.push(body);
    }
    const el                = { kind: 'element', tag, start: lt, nameEnd, openEnd, closeStart: openEnd, end: openEnd, attrs, children: [] };
    top().children.push(el);
    i = textFrom = openEnd;
    const foreign = FOREIGN.has(tag) || open.some((o) => FOREIGN.has(o.tag));
    if (VOID.has(tag) || (selfClosed && foreign)) continue;
    if (RAW.has(tag)) {
      const m = new RegExp(`</${tag}[^>]*>`, 'i').exec(text.slice(openEnd));
      const at = m ? openEnd + m.index : text.length;
      if (at > openEnd) el.children.push({ kind: 'text', start: openEnd, end: at });
      close(el, at, m ? at + m[0].length : text.length);
      i = textFrom = el.end;
      continue;
    }
    open.push(el);
  }
  flushText(text.length);
  for (let j = open.length - 1; j > 0; j--) close(open[j] , text.length, text.length);
  return root;
}

function readAttrs(text        , from        )                                                            {
  const attrs               = [];
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i] )) i++;
    if (i >= text.length) return { attrs, end: i, selfClosed: false };
    if (text[i] === '>') return { attrs, end: i + 1, selfClosed: false };
    if (text.startsWith('/>', i)) return { attrs, end: i + 2, selfClosed: true };
    if (text[i] === '/') { i++; continue; }
    const start = i;
    while (i < text.length && !/[\s=>]/.test(text[i] ) && !text.startsWith('/>', i)) i++;
    const name = text.slice(start, i).toLowerCase();
    while (i < text.length && /\s/.test(text[i] )) i++;
    if (text[i] !== '=') { attrs.push({ name, value: null, start, end: i }); continue; }
    i++;
    while (i < text.length && /\s/.test(text[i] )) i++;
    const q = text[i];
    let value        ;
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, i + 1);
      const stop = close < 0 ? text.length : close;
      value = text.slice(i + 1, stop);
      i = Math.min(text.length, stop + 1);
    } else {
      const s = i;
      while (i < text.length && !/[\s>]/.test(text[i] )) i++;
      value = text.slice(s, i);
    }
    attrs.push({ name, value: decodeAttr(value), start, end: i });
  }
}

const decodeAttr = (v        ) => v.replace(/&(quot|amp|lt|gt|#39|apos);/g, (_, e        ) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", apos: "'" })[e] ?? _);

export const elementsOf = (el               )                  => el.children.filter((c)                     => c.kind === 'element');

/** The page's `<body>` as its file has it (a page without the tag: what is not its head). */
export function sourceBody(root               )                {
  const find = (el               )                       => {
    for (const c of elementsOf(el)) {
      if (c.tag === 'body') return c;
      if (c.tag === 'html') { const b = find(c); if (b) return b; }
    }
    return null;
  };
  const body = find(root);
  if (body) return body;
  const html = elementsOf(root).find((c) => c.tag === 'html') ?? root;
  return { ...html, tag: 'body', children: html.children.filter((c) => c.kind !== 'element' || !['head', 'html'].includes(c.tag)) };
}

/** The element at `path` (element after element, from `from`), when every step is there with the tag `tags` says. */
export function elementAt(from               , path                   , tags                   )                       {
  let at                            = from;
  for (const [k, i] of path.entries()) {
    at = at ? elementsOf(at)[i] : undefined;
    if (!at || (tags[k] && at.tag !== tags[k] .toLowerCase())) return null;
  }
  return at ?? null;
}

/** Whether `el` holds what the browser's reading of it holds, element for element (`shape`: tag and children). */
                                                         
export function sameShape(el               , shape       )          {
  if (el.tag !== shape.tag.toLowerCase()) return false;
  const kids = elementsOf(el);
  return kids.length === shape.children.length && kids.every((k, i) => sameShape(k, shape.children[i] ));
}
