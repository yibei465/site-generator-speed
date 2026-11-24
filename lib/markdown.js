// makefun-site's Markdown: its own subset, lexed and rendered in one pass over the
// lines (no token objects), in the shape of marked's lexer and parser. Blocks: ATX headings (each with an id),
// fenced code, thematic breaks, blockquotes, flat lists and paragraphs. Inline: code spans, strong, emphasis,
// links and backslash escapes. No raw HTML (every < is escaped), no setext headings, no indented code, no tables,
// no reference links, no underscore emphasis.
// The inline scanner batches plain runs into single escape calls instead of escaping character by character.

import { escapeHtml, slugify, uniqueSlug } from './text.js';

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. The first character
 * decides which test can match, so most lines take no regex at all. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct. One shared regex; every use sets lastIndex first, so the
 * recursion through it is safe. */
const SPECIAL = /[\\`*\[]/g;

/** `s[a..b)` rendered inline into `out`; `env.link(target)` is a link's href. Plain runs are found by one regex
 * search each instead of stepping character by character. */
export function inlineInto(s, a, b, env, out) {
  let i = a;
  let run = a;
  const flush = (end) => {
    if (end > run) out.push(escapeHtml(s.slice(run, end)));
  };
  while (true) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    const j = m === null || m.index >= b ? -1 : m.index;
    if (j === -1) {
      flush(b);
      return;
    }
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        flush(j);
        // escapeHtml is the identity on every escapable character except '>', which becomes &gt;
        out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
        run = i;
      } else {
        i = j + 1; // a literal backslash; it stays in the plain run
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        flush(j);
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          flush(j);
          out.push('<strong>');
          inlineInto(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
          run = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        flush(j);
        out.push('<em>');
        inlineInto(s, j + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    if (m2 >= b) m2 = -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      flush(j);
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s, j + 1, k, env, out);
      out.push('</a>');
      i = m2 + 1;
      run = i;
    } else {
      i = j + 1;
    }
  }
}

/** `s` rendered inline. */
export function inline(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

/** One list block, from the line `i` (already known to start it), rendered into `parts`; returns the next line. */
function listBlock(lines, i, n, isOrdered, first, env, parts) {
  const marker = isOrdered ? ORDERED : BULLET;
  const items = [];
  while (i < n) {
    const m = marker.exec(lines[i]);
    if (m !== null) {
      items.push([trimLine(isOrdered ? m[2] : m[1])]);
      i++;
    } else if (CONTINUED.test(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const start = isOrdered ? Number(first[1]) : 1;
  const tag = isOrdered ? 'ol' : 'ul';
  parts.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
  for (const item of items) {
    parts.push('<li>');
    const text = item.join('\n');
    inlineInto(text, 0, text.length, env, parts);
    parts.push('</li>\n');
  }
  parts.push(`</${tag}>\n`);
  return i;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * The first character decides which block test can match, so most lines take no regex at all. Inline content is
 * pushed straight into the shared parts array; only the first paragraph (its excerpt) and headings (their toc
 * entries) are rendered to a string of their own.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) {
        i++;
        continue;
      }
      // Otherwise a paragraph line: no block can start with a space or tab.
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        // The language's characters can never need escaping; the class is built directly.
        parts.push(`<pre><code${fence[1] === '' ? '' : ` class="language-${fence[1]}"`}>`);
        for (const l of body) {
          parts.push(escapeHtml(l), '\n');
        }
        parts.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        i = listBlock(lines, i, n, false, bullet, env, parts);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      if (inner.length === 0) {
        parts.push('<blockquote>\n</blockquote>\n');
      } else {
        const text = inner.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        i = listBlock(lines, i, n, true, ordered, env, parts);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    if (excerpt === null) {
      const html = inline(body.join('\n'), env);
      excerpt = html;
      parts.push('<p>', html, '</p>\n');
    } else {
      parts.push('<p>');
      const text = body.join('\n');
      inlineInto(text, 0, text.length, env, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}
