// solve.js: a faster drop-in for makefun-site 1.0.0's build. Same pipeline, same output, byte for byte.
// Speed comes from three things:
//   1. templates are compiled once into closures, and every include / if / for fragment is memoised on the values of
//      the names it reads (its free names), so the shared chrome (head, header, nav, footer, tag lists, cards) is
//      rendered once per distinct input instead of once per page;
//   2. every fragment is kept already JSON-escaped, so the answer file is written by concatenation, never by
//      JSON.stringify over megabytes of HTML;
//   3. Markdown and HTML escaping scan whole runs of plain characters instead of one character at a time.
// run(input) returns the output tree as an object (the contract); buildJson(input) returns it as JSON text.

const INCLUDE_DEPTH = 8;
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

/** HTML escape (& < > " '). */
function escapeHtml(t) {
  let out = '';
  let last = 0;
  const n = t.length;
  for (let i = 0; i < n; i++) {
    const c = t.charCodeAt(i);
    if (c > 62) continue;
    let r;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    if (i > last) out += t.slice(last, i);
    out += r;
    last = i + 1;
  }
  if (last === 0) return t;
  return last < n ? out + t.slice(last) : out;
}

/** The body of a JSON string literal for `s` (no quotes). */
function jsonEsc(s) {
  const n = s.length;
  if (n > 48) return JSON.stringify(s).slice(1, -1);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 34 || c === 92 || (c >= 0xd800 && c <= 0xdfff)) return JSON.stringify(s).slice(1, -1);
  }
  return s;
}

/** HTML-escaped and then JSON-escaped in one pass. */
function escHJ(t) {
  let out = '';
  let last = 0;
  const n = t.length;
  for (let i = 0; i < n; i++) {
    const c = t.charCodeAt(i);
    let r;
    if (c > 62) {
      if (c === 92) r = '\\\\';
      else if (c >= 0xd800 && c <= 0xdfff) return jsonEsc(escapeHtml(t));
      else continue;
    } else if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else if (c < 32) r = JSON.stringify(String.fromCharCode(c)).slice(1, -1);
    else continue;
    if (i > last) out += t.slice(last, i);
    out += r;
    last = i + 1;
  }
  if (last === 0) return t;
  return last < n ? out + t.slice(last) : out;
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** makefun-site's slug rule. */
function slugify(text) {
  let r = slugCache.get(text);
  if (r !== undefined) return r;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
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
  r = out === '' ? 'untitled' : out;
  slugCache.set(text, r);
  return r;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code c is JavaScript regex whitespace (\s). */
function isWS(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 160) return false;
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The count of /\S+/g matches. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 160) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else if (c <= 32 ? c === 32 || (c >= 9 && c <= 13) : isWS(c)) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length >= 2 && raw.endsWith('"') && raw.indexOf('\\') === -1 && raw.indexOf('"', 1) === raw.length - 1) return { value: raw.slice(1, -1) };
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // lines after `close`, joined by "\n": the text after the close line's own newline.
  let pos = 0;
  for (let i = 0; i <= close; i++) pos += lines[i].length + 1;
  return { data, body: pos > text.length ? '' : text.slice(pos) };
}

// ------------------------------------------------------------------ markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

const isFenceOpen = (line) => line.charCodeAt(0) === 96 && FENCE_OPEN.test(line);
const isHR = (line) => {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line);
};

function endsParagraph(line) {
  return isBlankLine(line) || isFenceOpen(line) || headingOf(line) !== null || isHR(line);
}

/** Spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      tokens.push({ type: 'blockquote', lines: body });
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (lines[i].charCodeAt(0) === 32 && CONTINUED.test(lines[i])) {
          items[items.length - 1] += '\n' + trimLine(lines[i]);
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items });
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) text += '\n' + trimLine(lines[i++]);
    tokens.push({ type: 'paragraph', text });
  }
  return tokens;
}

/** \ ` * _ [ ] ( ) # + - . ! > */
function isEscapable(c) {
  switch (c) {
    case 92: case 96: case 42: case 95: case 91: case 93: case 40: case 41:
    case 35: case 43: case 45: case 46: case 33: case 62:
      return true;
    default:
      return false;
  }
}

function findUnescaped(s, what, from) {
  const n = s.length;
  const w0 = what.charCodeAt(0);
  const wl = what.length;
  for (let j = from; j <= n - wl; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && (wl === 1 || s.charCodeAt(j + 1) === what.charCodeAt(1))) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

function escOne(c) {
  switch (c) {
    case 38: return '&amp;';
    case 60: return '&lt;';
    case 62: return '&gt;';
    case 34: return '&quot;';
    case 39: return '&#39;';
    default: return String.fromCharCode(c);
  }
}

const SPECIAL = new Uint8Array(128);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL[c] = 1;

function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c < 128 && SPECIAL[c] === 1) break;
      j++;
    }
    if (j > i) {
      out += s.slice(i, j);
      i = j;
      if (i >= n) break;
    }
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        out += escOne(s.charCodeAt(i + 1));
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, k), env) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out += '<em>' + inline(s.slice(i + 1, k), env) + '</em>';
          i = k + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
      } else {
        out += '[';
        i++;
      }
    } else {
      out += escOne(c);
      i++;
    }
  }
  return out;
}

function renderMarkdown(src, env) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const h = inline(t.text, env);
        html += `<h${t.depth} id="${id}">${h}</h${t.depth}>\n`;
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html: h });
        break;
      }
      case 'code': {
        let body = '';
        for (const l of t.lines) body += escapeHtml(l) + '\n';
        html += (t.lang === '' ? '<pre><code>' : `<pre><code class="language-${escapeHtml(t.lang)}">`) + body + '</code></pre>\n';
        break;
      }
      case 'hr':
        html += '<hr>\n';
        break;
      case 'blockquote':
        html += t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        let s = t.ordered && t.start !== 1 ? `<ol start="${t.start}">\n` : `<${tag}>\n`;
        for (const item of t.items) s += `<li>${inline(item, env)}</li>\n`;
        html += s + `</${tag}>\n`;
        break;
      }
      case 'paragraph': {
        const h = inline(t.text, env);
        if (excerpt === null) excerpt = h;
        html += `<p>${h}</p>\n`;
        break;
      }
    }
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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

function parseTemplate(name, src) {
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

// Scopes: a chain of frames. The root frame is { root: true, vars, parent: null }; a for frame is
// { root: false, name, value, loop, parent }. A name resolves as makefun-site's lookup does: the nearest frame that
// holds it ("loop" in a for frame always the loop record, as an object literal's later key wins), then the root vars.
function lookupName(sc, name) {
  for (let s = sc; ; s = s.parent) {
    if (s.root) return Object.hasOwn(s.vars, name) ? s.vars[name] : undefined;
    if (name === 'loop') return s.loop;
    if (s.name === name) return s.value;
  }
}

function lookupPath(sc, path) {
  let v = lookupName(sc, path[0]);
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INF = 1e9;

/**
 * The compiled templates of one build: name -> fn(scope, depth) giving that template's output, JSON-escaped.
 * Each include / if / for node is wrapped in a memo keyed on the values of its free names.
 */
function compileTemplates(parsed) {
  // Free names and include height of each template, by a fixpoint that also copes with includes that recurse.
  const free = new Map(); // name -> Set
  const height = new Map(); // name -> number (INF when it recurses)
  for (const name of parsed.keys()) {
    free.set(name, new Set());
    height.set(name, 0);
  }
  const nodeFree = (nodes, bound, out) => {
    for (const n of nodes) {
      switch (n.kind) {
        case 'var':
        case 'raw':
          if (!bound.has(n.path[0])) out.add(n.path[0]);
          break;
        case 'if':
          if (!bound.has(n.path[0])) out.add(n.path[0]);
          nodeFree(n.then, bound, out);
          if (n.else !== null) nodeFree(n.else, bound, out);
          break;
        case 'for': {
          if (!bound.has(n.path[0])) out.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          nodeFree(n.body, b2, out);
          break;
        }
        case 'include': {
          const f = free.get(n.name);
          if (f !== undefined) for (const x of f) if (!bound.has(x)) out.add(x);
          break;
        }
      }
    }
    return out;
  };
  const nodeHeight = (nodes) => {
    let h = 0;
    for (const n of nodes) {
      if (n.kind === 'if') h = Math.max(h, nodeHeight(n.then), n.else === null ? 0 : nodeHeight(n.else));
      else if (n.kind === 'for') h = Math.max(h, nodeHeight(n.body));
      else if (n.kind === 'include' && parsed.has(n.name)) h = Math.max(h, 1 + height.get(n.name));
    }
    return Math.min(h, INF);
  };
  for (let changed = true, rounds = 0; changed; rounds++) {
    changed = false;
    for (const [name, nodes] of parsed) {
      const f = nodeFree(nodes, new Set(), new Set());
      if (f.size !== free.get(name).size) {
        free.set(name, f);
        changed = true;
      }
      let h = nodeHeight(nodes);
      if (rounds > parsed.size + 2 && h > height.get(name)) h = INF;
      if (h !== height.get(name)) {
        height.set(name, h);
        changed = true;
      }
    }
  }

  const fns = new Map();
  const callInclude = (name) => (sc, depth) => {
    const f = fns.get(name);
    return f !== undefined && depth < INCLUDE_DEPTH ? f(sc, depth + 1) : '';
  };

  const memo = (nodeList, inner) => {
    const names = [...nodeFree(nodeList, new Set(), new Set())];
    const h = nodeHeight(nodeList);
    if (names.includes('loop')) return inner;
    const cache = new Map();
    const nn = names.length;
    if (nn === 0) {
      let done = false;
      let val = '';
      return (sc, depth) => {
        if (depth + h > INCLUDE_DEPTH) return inner(sc, depth);
        if (!done) {
          val = inner(sc, depth);
          done = true;
        }
        return val;
      };
    }
    if (nn === 1) {
      const n0 = names[0];
      return (sc, depth) => {
        if (depth + h > INCLUDE_DEPTH) return inner(sc, depth);
        const v = lookupName(sc, n0);
        let r = cache.get(v);
        if (r === undefined) {
          r = inner(sc, depth);
          cache.set(v, r);
        }
        return r;
      };
    }
    return (sc, depth) => {
      if (depth + h > INCLUDE_DEPTH) return inner(sc, depth);
      let m = cache;
      for (let k = 0; k < nn - 1; k++) {
        const v = lookupName(sc, names[k]);
        let nx = m.get(v);
        if (nx === undefined) {
          nx = new Map();
          m.set(v, nx);
        }
        m = nx;
      }
      const v = lookupName(sc, names[nn - 1]);
      let r = m.get(v);
      if (r === undefined) {
        r = inner(sc, depth);
        m.set(v, r);
      }
      return r;
    };
  };

  const compileList = (nodes) => {
    const parts = nodes.map(compileNode);
    // Adjacent constant strings were already merged by the parser's token rules; join at render time.
    const k = parts.length;
    if (k === 0) return () => '';
    if (k === 1) {
      const p0 = parts[0];
      return typeof p0 === 'string' ? () => p0 : p0;
    }
    const isStr = parts.map((p) => typeof p === 'string');
    return (sc, depth) => {
      let out = '';
      for (let j = 0; j < k; j++) out += isStr[j] ? parts[j] : parts[j](sc, depth);
      return out;
    };
  };

  function compileNode(n) {
    switch (n.kind) {
      case 'text':
        return jsonEsc(n.text);
      case 'var': {
        const p = n.path;
        if (p.length === 1) {
          const p0 = p[0];
          return (sc) => escHJ(textOf(lookupName(sc, p0)));
        }
        return (sc) => escHJ(textOf(lookupPath(sc, p)));
      }
      case 'raw': {
        const p = n.path;
        return (sc) => jsonEsc(textOf(lookupPath(sc, p)));
      }
      case 'if': {
        const p = n.path;
        const not = n.not;
        const th = compileList(n.then);
        const el = n.else === null ? null : compileList(n.else);
        const inner = (sc, depth) => {
          const v = truthy(lookupPath(sc, p));
          if (v !== not) return th(sc, depth);
          return el === null ? '' : el(sc, depth);
        };
        return memo([n], inner);
      }
      case 'for': {
        const p = n.path;
        const name = n.name;
        const body = compileList(n.body);
        const inner = (sc, depth) => {
          const xs = lookupPath(sc, p);
          if (!Array.isArray(xs)) return '';
          let out = '';
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const frame = { root: false, name, value: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len }, parent: sc };
            out += body(frame, depth);
          }
          return out;
        };
        return memo([n], inner);
      }
      case 'include':
        return memo([n], callInclude(n.name));
    }
    throw new Error('unknown node');
  }

  for (const [name, nodes] of parsed) fns.set(name, compileList(nodes));
  return fns;
}

// ------------------------------------------------------------------ the build

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

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

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree as JSON object text. */
export function buildJson(input) {
  // Templates, parsed in code-unit order of their names.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: s.post ? s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })) : c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const fns = compileTemplates(parsed);
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const f = fns.get(name);
    if (f === undefined) return null;
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    return f({ root: true, vars, parent: null }, 0);
  };
  const out = new Map(); // path -> JSON-escaped text
  for (const s of sources) out.set(`${s.outDir}/index.html`, render(s.layout, { page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) out.set(k === 1 ? 'index.html' : `page/${k}/index.html`, html);
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) out.set(`tags/${t.slug}/index.html`, html);
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) out.set('tags/index.html', tagsHtml);
  for (const f of statics) {
    if (out.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else out.set(f.path, jsonEsc(f.content));
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = sources.length - posts.length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  out.set(REPORT_FILE, jsonEsc(`${lines.join('\n')}\n`));

  let json = '{';
  let first = true;
  for (const [k, v] of out) {
    json += (first ? '"' : ',"') + jsonEsc(k) + '":"' + v + '"';
    first = false;
  }
  return json + '}';
}

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  return JSON.parse(buildJson(input));
}
