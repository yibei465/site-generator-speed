// makefun-site's template dialect: its own, not Liquid, Nunjucks, Mustache or EJS.
//
//   {{ path }}               the value at path, HTML-escaped
//   {{{ path }}}             the value at path, raw
//   {% for x in path %} ... {% endfor %}      each element of an array, x bound to it and loop to
//                                             { index (from 1), first, last, length }
//   {% if path %} ... {% else %} ... {% endif %}   and {% if not path %}; the else is optional
//   {% include "name" %}     the template `name` rendered in the same scope, at most INCLUDE_DEPTH deep
//
// A path is names joined by dots (a-z, A-Z, 0-9 and _, from a letter or _). A {% %} tag alone on its line (only spaces
// or tabs beside it) takes its whole line with it, its newline included. A template is parsed once into a tree of
// nodes, then compiled to a JavaScript function: loop variables bound by this template's own loops become real
// variables, other names are looked up in the scope chain, and rendering appends to an array joined once at the end.

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`'s first name in the scope chain: the nearest scope holding it. */
export function lookupFirst(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, name)) return s.vars[name];
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
export function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- compilation

/** Whether `nodes` hold an include anywhere (through for and if bodies). */
function hasInclude(nodes) {
  for (const n of nodes) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && hasInclude(n.body)) return true;
    if (n.kind === 'if' && (hasInclude(n.then) || (n.else !== null && hasInclude(n.else)))) return true;
  }
  return false;
}

/** Whether `nodes` use `name` as a path's first name anywhere (through for and if bodies, not through includes). */
function usesName(nodes, name) {
  for (const n of nodes) {
    if ((n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') && n.path[0] === name) return true;
    if (n.kind === 'for') {
      if (n.path[0] === name) return true;
      if (usesName(n.body, name)) return true;
    }
    if (n.kind === 'if' && (usesName(n.then, name) || (n.else !== null && usesName(n.else, name)))) return true;
  }
  return false;
}

/** The include names `nodes` hold, in order of first use. */
function includeNames(nodes, into = []) {
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (!into.includes(n.name)) into.push(n.name);
    } else if (n.kind === 'for') includeNames(n.body, into);
    else if (n.kind === 'if') {
      includeNames(n.then, into);
      if (n.else !== null) includeNames(n.else, into);
    }
  }
  return into;
}

/**
 * `nodes` compiled to a function (out, S, D, T, esc, textOf, truthy, lk): out is the array rendered into, S the
 * scope chain, D the include depth, T the map of compiled templates by name, and the rest the helpers. Loop
 * variables bound by this template's own loops become real variables; any other first name is looked up in the
 * scope chain, so an included template still sees its includer's loop bindings.
 */
export function compileTemplate(nodes) {
  let uid = 0;
  const id = () => uid++;
  const lines = [];
  const includes = includeNames(nodes);
  for (const name of includes) lines.push(`const _inc${id()} = T.get(${JSON.stringify(name)});`);
  const incVar = new Map(includes.map((name, k) => [name, `_inc${k}`]));

  // The compile-time state: the stack of this template's own loop bindings (innermost last), the variable
  // holding the scope chain includes see, and the path temps declared at the top of the function.
  const state = { loops: [], chain: 'S', temps: [] };

  /** The expression for `path`'s value in the current compile-time state. */
  function pathExpr(path) {
    const first0 = path[0];
    let first;
    if (first0 === 'loop') {
      // `loop` is the innermost loop's loop object, never an element (a loop named 'loop' shadows its element).
      if (state.loops.length > 0) first = state.loops[state.loops.length - 1].loopVar;
    } else {
      for (let k = state.loops.length - 1; k >= 0; k--) {
        const L = state.loops[k];
        if (L.name === first0 && L.elemVar !== null) {
          first = L.elemVar;
          break;
        }
      }
    }
    if (first === undefined || first === null) first = `lk(${state.chain}, ${JSON.stringify(first0)})`;
    if (path.length === 1) return first;
    const t = `_p${id()}`;
    state.temps.push(t);
    let expr = `${t} = ${first}`;
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      expr += `, ${t} = (${t} !== null && typeof ${t} === 'object' && Object.hasOwn(${t}, ${seg})) ? ${t}[${seg}] : undefined`;
    }
    return `(${expr}, ${t})`;
  }

  function gen(nodes) {
    for (const n of nodes) {
      if (n.kind === 'text') {
        lines.push(`out.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var') {
        lines.push(`out.push(esc(textOf(${pathExpr(n.path)})));`);
      } else if (n.kind === 'raw') {
        lines.push(`out.push(textOf(${pathExpr(n.path)}));`);
      } else if (n.kind === 'if') {
        const cond = n.not ? `!truthy(${pathExpr(n.path)})` : `truthy(${pathExpr(n.path)})`;
        lines.push(`if (${cond}) {`);
        gen(n.then);
        if (n.else !== null) {
          lines.push('} else {');
          gen(n.else);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
        const u = id();
        const xs = `_xs${u}`;
        const k = `_k${u}`;
        const useElem = usesName(n.body, n.name);
        const useLoop = usesName(n.body, 'loop');
        const needFrame = hasInclude(n.body);
        const elemVar = useElem ? `_v${u}` : null;
        const loopVar = useLoop || needFrame ? `_l${u}` : null;
        const frameVar = needFrame ? `_f${u}` : null;
        lines.push(`{ const ${xs} = ${pathExpr(n.path)}; if (Array.isArray(${xs})) { for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) {`);
        if (elemVar !== null) lines.push(`const ${elemVar} = ${xs}[${k}];`);
        if (loopVar !== null) {
          lines.push(`const ${loopVar} = { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length };`);
        }
        const prevChain = state.chain;
        if (frameVar !== null) {
          const elemSrc = elemVar !== null ? elemVar : `${xs}[${k}]`;
          lines.push(`const ${frameVar} = { vars: { [${JSON.stringify(n.name)}]: ${elemSrc}, loop: ${loopVar} }, parent: ${prevChain} };`);
          state.chain = frameVar;
        }
        state.loops.push({ name: n.name, elemVar, loopVar });
        gen(n.body);
        state.loops.pop();
        state.chain = prevChain;
        lines.push('} } }');
      } else if (n.kind === 'include') {
        const v = incVar.get(n.name);
        lines.push(`{ const _t = ${v}; if (_t !== undefined && D < ${INCLUDE_DEPTH}) _t(out, ${state.chain}, D + 1, T, esc, textOf, truthy, lk); }`);
      }
    }
  }

  gen(nodes);
  if (state.temps.length > 0) lines.unshift(`let ${state.temps.join(', ')};`);
  const fn = new Function('out', 'S', 'D', 'T', 'esc', 'textOf', 'truthy', 'lk', lines.join('\n'));
  return fn;
}
