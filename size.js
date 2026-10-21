// Size math, limits and byte-exact padding. No DOM here, so node --test can load it.

const CHUNK = 4 * 1024 * 1024;
const ZIP_MAX = 0xffffffff - 1024 * 1024; // fflate does not write ZIP64
const MEDIA_MAX = 1.5 * 1024 ** 3;        // ffmpeg.wasm keeps input + output in memory

const set = (...exts) => new Set(exts);
const FAMILY = {
  isobmff: set('mp4', 'mov', 'm4a', 'm4v', 'heic', 'heif', 'avif', '3gp'),
  officeZip: set('xlsx', 'xlsm', 'docx', 'docm', 'pptx', 'pptm', 'odt', 'ods', 'odp', 'epub'),
  zip: set('zip', 'jar'),
  ole: set('xls', 'doc', 'ppt', 'msg'),
  text: set('txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'svg', 'rtf', 'js', 'css', 'log', 'yaml', 'yml'),
  image: set('jpg', 'jpeg', 'png', 'webp'),
  heic: set('heic', 'heif'),
  video: set('mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts'),
  audio: set('mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma'),
};
const is = (family, ext) => FAMILY[family].has(ext);
const isZipLike = (ext) => is('officeZip', ext) || is('zip', ext);

// ---------- helpers ----------

// 1 MB = 1024 KB, like Chrome, Windows and most upload limits.
const base = () => 1024;

function parseSize(value, unit) {
  const n = parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * base() ** Number(unit));
}

function fmt(bytes, b = base()) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= b && i < units.length - 1) { v /= b; i++; }
  return `${v.toLocaleString('pl-PL', { maximumFractionDigits: i ? 2 : 0 })} ${units[i]}`;
}

const fmtBytes = (bytes) => `${bytes.toLocaleString('pl-PL')} B`;

function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

function cleanExt(value) {
  return value.trim().replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function cleanStem(value) {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-') || 'plik-testowy';
}

// ---------- padding ----------

const encoder = new TextEncoder();

let chunkCache = {};
function fillChunk(kind) {
  if (chunkCache[kind]) return chunkCache[kind];
  const c = new Uint8Array(CHUNK);
  if (kind === 'random') {
    for (let i = 0; i < CHUNK; i += 65536) crypto.getRandomValues(c.subarray(i, i + 65536));
  } else if (kind === 'text') {
    const line = encoder.encode('Plik testowy wygenerowany do sprawdzenia limitu wagi. Lorem ipsum dolor sit amet.\n');
    for (let i = 0; i < CHUNK; i += line.length) c.set(line.subarray(0, Math.min(line.length, CHUNK - i)), i);
  } else if (kind === 'letters') {
    // Random letters and digits: readable as text and still barely compressible.
    const abc = encoder.encode('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    for (let i = 0; i < CHUNK; i += 65536) crypto.getRandomValues(c.subarray(i, i + 65536));
    for (let i = 0; i < CHUNK; i++) c[i] = (i % 80 === 79) ? 0x0a : abc[c[i] % abc.length];
  } else if (kind === 'pdf-letters' || kind === 'pdf-text') {
    // Lines of PDF comments ("%…\n"), so readers skip the whole block.
    const src = fillChunk(kind === 'pdf-letters' ? 'letters' : 'text');
    for (let i = 0; i < CHUNK; i++) {
      const col = i % 80;
      c[i] = col === 0 ? 0x25 : col === 79 ? 0x0a : (src[i] === 0x0a ? 0x20 : src[i]);
    }
  } else if (kind === 'space') {
    c.fill(0x20);
  } else if (kind === 'silence') {
    c.fill(0x80);
  }
  return (chunkCache[kind] = c);
}

// Blob parts of exactly n bytes, reusing one shared chunk so huge sizes stay cheap.
function fillParts(n, kind) {
  const c = fillChunk(kind);
  const parts = [];
  for (let left = n; left > 0; left -= CHUNK) parts.push(left >= CHUNK ? c : c.subarray(0, left));
  return parts;
}

function fillBytes(n, kind) {
  const out = new Uint8Array(n);
  const c = fillChunk(kind);
  for (let i = 0; i < n; i += CHUNK) out.set(c.subarray(0, Math.min(CHUNK, n - i)), i);
  return out;
}

// Text files stay text: random bytes become random letters, zeros become spaces.
const textFill = (kind) => (kind === 'zero' ? 'space' : kind === 'random' ? 'letters' : kind);
// After the root element only whitespace and comments are allowed.
const MARKUP = set('xml', 'svg', 'html', 'htm');
const WHITESPACE_ONLY = set('json', 'rtf');

// Bytes appended to the end of a file so it still opens.
function trailingPadding(n, ext, kind, pdfStartxref) {
  if (n <= 0) return [];
  if (is('isobmff', ext) && n >= 16) {
    // An ISO-BMFF "free" box: players and image decoders skip it.
    const big = n > 0xffffffff;
    const head = new Uint8Array(big ? 16 : 8);
    const dv = new DataView(head.buffer);
    if (big) {
      dv.setUint32(0, 1);
      dv.setUint32(8, Math.floor(n / 2 ** 32));
      dv.setUint32(12, n >>> 0);
    } else {
      dv.setUint32(0, n);
    }
    head.set(encoder.encode('free'), 4);
    return [head, ...fillParts(n - head.length, kind)];
  }
  if (ext === 'pdf' && pdfStartxref != null) {
    // A PDF comment, then the last startxref repeated so readers still find the xref table.
    const tail = encoder.encode(`\nstartxref\n${pdfStartxref}\n%%EOF\n`);
    const head = encoder.encode('\n%');
    if (n >= head.length + tail.length) {
      const fill = kind === 'zero' ? 'space' : kind === 'random' ? 'pdf-letters' : 'pdf-text';
      return [head, ...fillParts(n - head.length - tail.length, fill), tail];
    }
  }
  if (MARKUP.has(ext) && kind !== 'zero') {
    const open = encoder.encode('\n<!--\n');
    const close = encoder.encode('\n-->\n');
    if (n >= open.length + close.length) return [open, ...fillParts(n - open.length - close.length, textFill(kind)), close];
  }
  if (WHITESPACE_ONLY.has(ext)) return fillParts(n, 'space');
  if (is('text', ext)) return fillParts(n, textFill(kind));
  return fillParts(n, kind);
}

// MP3: padding goes into an ID3v2 tag at the start (players skip it and the duration stays right).
const ID3_MAX = 2 ** 28 - 1;
const syncsafe = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];

const PRIV_OWNER = encoder.encode('file-size-tool\0');

// ID3 padding must be zeros, so other fills go into a PRIV frame (private data players skip).
// Returns exactly n bytes, or null when n is too small for a frame.
function id3Fill(n, version, kind) {
  if (kind === 'zero') return fillParts(n, 'zero');
  const body = n - 10;
  if (body <= PRIV_OWNER.length) return null;
  const size = version === 4 ? syncsafe(body) : [body >>> 24, (body >>> 16) & 0xff, (body >>> 8) & 0xff, body & 0xff];
  const header = Uint8Array.from([0x50, 0x52, 0x49, 0x56, ...size, 0, 0]);
  return [header, PRIV_OWNER, ...fillParts(body - PRIV_OWNER.length, kind)];
}

async function padMp3(blob, n, kind) {
  if (n <= 0) return blob;
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  const hasTag = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && !(head[5] & 0x10);
  if (hasTag) {
    const old = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    if (old + n <= ID3_MAX) {
      const header = Uint8Array.from([...head.subarray(0, 6), ...syncsafe(old + n)]);
      // A frame must come before the old frames' trailing padding, so it goes first.
      const plain = (head[3] === 3 || head[3] === 4) && !(head[5] & 0xc0);
      const frame = plain ? id3Fill(n, head[3], kind) : null;
      if (frame && kind !== 'zero') return new Blob([header, ...frame, blob.slice(10)]);
      return new Blob([header, blob.slice(10, 10 + old), ...fillParts(n, 'zero'), blob.slice(10 + old)]);
    }
  } else if (n >= 10 && n - 10 <= ID3_MAX) {
    const header = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(n - 10)]);
    return new Blob([header, ...(id3Fill(n - 10, 3, kind) ?? fillParts(n - 10, 'zero')), blob]);
  }
  return new Blob([blob, ...fillParts(n, kind)]);
}

async function findPdfStartxref(blob) {
  const tail = await blob.slice(Math.max(0, blob.size - 2048)).text();
  const all = [...tail.matchAll(/startxref\s+(\d+)/g)];
  return all.length ? all[all.length - 1][1] : null;
}

// Grows a (non-ZIP) file to exactly `target` bytes in a way its format tolerates.
async function padTo(blob, target, ext, kind = 'zero') {
  const n = target - blob.size;
  if (n <= 0) return blob;
  if (ext === 'mp3') return padMp3(blob, n, kind);
  const startxref = ext === 'pdf' ? await findPdfStartxref(blob) : null;
  return new Blob([blob, ...trailingPadding(n, ext, kind, startxref)]);
}

// What resizing a file of `size` bytes to `target` bytes means for its format.
function planResize(name, size, target) {
  if (!target) return { kind: 'none' };
  const { ext } = splitName(name);
  if (target === size) return { kind: 'same', target, ext };
  if (target > size) return { kind: 'grow', target, ext };
  if (is('heic', ext)) return { kind: 'heic', target, ext };
  if (is('image', ext)) return { kind: 'image', target, ext };
  if (is('video', ext) || is('audio', ext)) return { kind: 'media', target, ext };
  if (isZipLike(ext)) return { kind: 'zip', target, ext };
  if (ext === 'pdf') return { kind: 'pdf', target, ext };
  return { kind: 'unsupported', target, ext };
}

// ---------- arrow steppers ----------

// One click moves the number by a step you can see: 10 MB jumps by 1, 100 MB by 10, 1 MB by 0.1.
const STEP_LADDER = [0.1, 0.5, 1, 5, 10, 25, 50, 100, 250, 500];

function stepFor(value, unit) {
  const ideal = Math.abs(value) / 10;
  let step = STEP_LADDER[0];
  for (const s of STEP_LADDER) if (s <= ideal) step = s;
  // Bytes and kilobytes come in whole numbers, so a finer step there would round away.
  return Number(unit) <= 1 ? Math.max(1, Math.round(step)) : step;
}

// Where one arrow click from `from` lands.
function nextStep(from, unit, direction) {
  const step = stepFor(from, unit);
  let next = from + direction * step;
  if (next < step) next = step;                    // never step down to zero
  if (Number(unit) === 0) next = Math.round(next); // bytes come in whole numbers
  return next;
}

export {
  CHUNK, ZIP_MAX, MEDIA_MAX, ID3_MAX, FAMILY, MARKUP, WHITESPACE_ONLY, STEP_LADDER,
  set, is, isZipLike, base, parseSize, fmt, fmtBytes, splitName, cleanExt, cleanStem,
  fillChunk, fillParts, fillBytes, textFill, trailingPadding, syncsafe, id3Fill, padMp3, findPdfStartxref, padTo,
  planResize, stepFor, nextStep,
};
