// A faster drop-in for makefun-site 1.0.0: run(input) returns byte-for-byte the
// answer the reference build returns, for every input. Same pipeline, same
// rules; the speed comes from fused lexing/rendering, a batched inline scanner,
// an ASCII fast path for slugs, slice-based front matter, and array-joined
// template output. Written from the reference implementation's behavior.

import { parseFrontMatter } from './lib/frontmatter.js';
import { renderMarkdown } from './lib/markdown.js';
import { parseTemplate, compileTemplate, TemplateError, textOf, truthy, lookupFirst } from './lib/template.js';
import { escapeHtml, longDate, slugify, uniqueSlug } from './lib/text.js';

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. Counted by hand over the exact set
 * JavaScript's \s names, with no array built. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- the plugins, in order

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.link = linkOf(p);
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags as {name, slug} pairs, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) {
        const url = `${b.base}/tags/${slug}/`;
        bySlug.set(slug, { name, slug, url, posts: [], link: { name, slug, url } });
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  // The stand-in for a tag no post has is built once per slug and shared, as a real tag's link is.
  const noTag = new Map();
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(({ name, slug }) => {
        const tag = bySlug.get(slug);
        if (tag !== undefined) return tag;
        if (!noTag.has(slug)) noTag.set(slug, { name, slug, url: '', posts: [], link: { name, slug, url: '' } });
        return noTag.get(slug);
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.link),
  };
}

/** A page as its layout reads it: its card's fields, plus its own. The toc is already the shape layouts need. */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer ? s.newer.link : null,
    older: s.older ? s.older.link : null,
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  // The shared root scope holds site, tags and recent; each render's own vars hang under it, so no object is
  // spread per render and a render's key still wins over the shared ones, as in one flat object.
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const fn = b.compiled.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, { vars, parent: baseScope }, 0, b.compiled, escapeHtml, textOf, truthy, lookupFirst);
    return out.join('');
  };
  for (const s of b.sources) {
    const card = s.post ? b.cards.get(s) : cardOf(s);
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, card) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
export const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map([...templates.entries()].map(([name, nodes]) => [name, compileTemplate(nodes)]));
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
