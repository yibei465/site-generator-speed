// makefun-site's text rules: the HTML escape table, the slug rule and the long date.
// slugify keeps the reference's exact result; ASCII text takes a regex fast path.

/** The HTML escape table, in this order: & < > " ' (kept for reference; escapeHtml uses single-character replaces). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
void ESCAPES;

/** `text` with & < > " and ' escaped. A quick test skips the work when nothing needs it; the five
 * single-character replaces are then faster than one regex with a callback per match. */
const NEEDS_ESCAPE = /[&<>"']/;
export function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left.
 */
export function slugify(text) {
  if (!NON_ASCII.test(text)) {
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let a = 0;
    let b = out.length;
    while (a < b && out[a] === '-') a++;
    while (b > a && out[b - 1] === '-') b--;
    out = out.slice(a, b).slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
