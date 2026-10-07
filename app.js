import { TEMPLATES } from './templates.js';

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';
const HEIC2ANY_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const FFMPEG_CORE_MT = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm';
// Fixed count: x264's automatic thread count deadlocks ffmpeg.wasm's thread pool.
const ffThreads = window.crossOriginIsolated ? 4 : 0;

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

const $ = (id) => document.getElementById(id);
const els = {
  mode: $('mode'),
  generate: $('generate'), gName: $('g-name'), gExt: $('g-ext'), gSize: $('g-size'), gUnit: $('g-unit'),
  gExtSelect: $('g-ext-select'), gExtCustom: $('g-ext-custom-field'),
  gFill: $('g-fill'), gFillField: $('g-fill-field'), gNote: $('g-note'), gRun: $('g-run'),
  gPresets: $('g-presets'),
  resize: $('resize'), drop: $('drop'), dropTitle: $('drop-title'), dropSub: $('drop-sub'), rFile: $('r-file'),
  rSize: $('r-size'), rUnit: $('r-unit'), rPresets: $('r-presets'), rExact: $('r-exact'), rNote: $('r-note'), rRun: $('r-run'),
  status: $('status'), sText: $('s-text'), sBar: $('s-bar'), sCancel: $('s-cancel'), sResult: $('s-result'),
  theme: $('theme'), pageDrop: $('page-drop'),
};
const checked = (group) => group.querySelector('input:checked').value;

let busy = false;
let currentFile = null;
let resultUrl = null;

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

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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

// ---------- ZIP / Office ----------

let fflate = null;
const loadFflate = async () => (fflate ??= await import(FFLATE_URL));

const PAD_PARTS = ['docProps/app.xml', 'docProps/core.xml', 'meta.xml', '[Content_Types].xml', 'META-INF/container.xml'];

function padPartFor(entries) {
  return PAD_PARTS.find((p) => p in entries) ?? null;
}

// Builds a ZIP. Office/ODF/EPUB files get whitespace after the root element of an XML part
// (valid XML, nothing else changes); plain ZIPs get an extra stored padding.bin entry.
function buildZip(entries, level, padBytes) {
  const padPart = padPartFor(entries);
  const out = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === padPart && padBytes > 0) {
      const merged = new Uint8Array(data.length + padBytes);
      merged.set(data);
      merged.fill(0x20, data.length);
      out[name] = [merged, { level: 0 }];
    } else {
      out[name] = [data, { level: name === 'mimetype' || name.endsWith('/') ? 0 : level }];
    }
  }
  if (!padPart && padBytes > 0) out['padding.bin'] = [new Uint8Array(padBytes), { level: 0 }];
  else if (padPart && padBytes === 0) out[padPart][1] = { level: 0 };
  return fflate.zipSync(out);
}

// Returns a ZIP of exactly `target` bytes, or null if the content alone is already bigger.
function zipToExact(entries, level, target) {
  if (target > ZIP_MAX) throw new Error('Pliki ZIP i Office powyżej 4 GB nie są obsługiwane.');
  const padPart = padPartFor(entries);
  // padding.bin costs its headers too, so measure with a 1-byte entry and subtract.
  const probe = buildZip(entries, level, padPart ? 0 : 1).length - (padPart ? 0 : 1);
  let n = target - probe;
  if (n < (padPart ? 0 : 1)) return null;
  for (let i = 0; i < 3; i++) {
    const zip = buildZip(entries, level, n);
    if (zip.length === target) return zip;
    n += target - zip.length;
  }
  throw new Error('Nie udało się trafić w dokładną wagę archiwum.');
}

function unzipFile(u8) {
  try {
    return fflate.unzipSync(u8);
  } catch {
    throw new Error('Nie udało się otworzyć pliku jako archiwum. Plik zabezpieczony hasłem? Takich nie da się przerobić.');
  }
}

const OFFICE_IMAGE = /(^|\/)(media|Pictures|images?)\/[^/]+\.(jpe?g|png)$/i;

async function shrinkZip(u8, ext, target, exact, onStep) {
  await loadFflate();
  const entries = unzipFile(u8);
  onStep('Pakuję mocniej…');
  let best = buildZip(entries, 9, 0);
  let smallest = best.length;
  if (best.length > target && is('officeZip', ext)) {
    const images = Object.keys(entries).filter((n) => OFFICE_IMAGE.test(n));
    if (images.length) {
      const bitmaps = {};
      for (const name of images) {
        try { bitmaps[name] = await createImageBitmap(new Blob([entries[name]])); } catch { /* skip undecodable */ }
      }
      const variant = async (t) => {
        const copy = { ...entries };
        for (const name of Object.keys(bitmaps)) {
          const png = /\.png$/i.test(name);
          const scale = png ? 1 - 0.75 * t : t < 0.4 ? 1 : 1 - ((t - 0.4) / 0.6) * 0.7;
          const blob = await encodeBitmap(bitmaps[name], scale, png ? 'image/png' : 'image/jpeg', 0.85 - 0.75 * t);
          if (blob && blob.size < entries[name].length) copy[name] = new Uint8Array(await blob.arrayBuffer());
        }
        return copy;
      };
      let lo = 0, hi = 1, bestEntries = null;
      for (let i = 0; i < 7; i++) {
        const t = i === 0 ? 1 : (lo + hi) / 2;
        onStep(`Zmniejszam zdjęcia w środku pliku (próba ${i + 1} z 7)…`);
        const candidate = await variant(t);
        const size = buildZip(candidate, 9, 0).length;
        smallest = Math.min(smallest, size);
        if (size <= target) { bestEntries = candidate; hi = t; } else if (i === 0) break; else lo = t;
      }
      if (bestEntries) {
        Object.assign(entries, bestEntries);
        best = buildZip(entries, 9, 0);
      }
    }
  }
  if (best.length > target) {
    throw new Error(`Najmniej, ile wyszło: ${fmt(smallest)}. Mniej się nie da bez usuwania zawartości.`);
  }
  if (!exact) return best;
  return zipToExact(entries, 9, target);
}

async function growZip(u8, target) {
  await loadFflate();
  const entries = unzipFile(u8);
  for (const level of [6, 9]) {
    const zip = zipToExact(entries, level, target);
    if (zip) return zip;
  }
  throw new Error('Po przepakowaniu plik i tak przekracza docelową wagę. Wybierz trochę większą.');
}

// ---------- images ----------

async function encodeBitmap(bitmap, scale, mime, quality) {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

// EXIF, XMP and IPTC segments of a JPEG; canvas re-encoding drops them, so they are copied back.
// ICC is left to the encoder: the canvas already converted the pixels to its own profile.
async function jpegMeta(blob) {
  const b = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  const segs = [];
  if (b[0] !== 0xff || b[1] !== 0xd8) return segs;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end > b.length) break;
    if (marker === 0xe1 || marker === 0xed) segs.push(resetOrientation(b.slice(i, end)));
    i = end;
  }
  return segs;
}

// The canvas already holds the rotated pixels, so a copied Orientation tag would rotate twice.
function resetOrientation(seg) {
  const isExif = String.fromCharCode(...seg.subarray(4, 8)) === 'Exif';
  if (!isExif || seg.length < 18) return seg;
  const view = new DataView(seg.buffer);
  const tiff = 10;
  const le = seg[tiff] === 0x49;
  const ifd = tiff + view.getUint32(tiff + 4, le);
  if (ifd + 2 > seg.length) return seg;
  const count = view.getUint16(ifd, le);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > seg.length) break;
    if (view.getUint16(entry, le) === 0x0112) view.setUint16(entry + 8, 1, le);
  }
  return seg;
}

// Puts the original metadata segments right after SOI, in place of the encoder's JFIF header.
async function withJpegMeta(blob, segs) {
  if (!segs.length) return blob;
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  let start = 2;
  if (head[2] === 0xff && head[3] === 0xe0) start = 4 + ((head[4] << 8) | head[5]);
  return new Blob([head.subarray(0, 2), ...segs, blob.slice(start)], { type: 'image/jpeg' });
}

// `overhead` = bytes added afterwards (copied metadata), only used to report the smallest size.
async function shrinkImage(blob, mime, target, onStep, overhead = 0) {
  const bitmap = await createImageBitmap(blob);
  let best = null;
  let smallest = Infinity;
  const keep = (b) => {
    if (b) smallest = Math.min(smallest, b.size);
    if (b && b.size <= target && (!best || b.size > best.size)) best = b;
  };
  if (mime !== 'image/png') {
    let lo = 0.05, hi = 0.95;
    for (let i = 0; i < 8; i++) {
      onStep(`Dobieram jakość (próba ${i + 1})…`);
      const q = (lo + hi) / 2;
      const b = await encodeBitmap(bitmap, 1, mime, q);
      keep(b);
      if (b.size <= target) lo = q; else hi = q;
    }
  }
  if (!best) {
    let lo = 0.03, hi = 1;
    for (let i = 0; i < 9; i++) {
      onStep(`Dobieram rozdzielczość (próba ${i + 1})…`);
      const s = (lo + hi) / 2;
      const b = await encodeBitmap(bitmap, s, mime, 0.8);
      keep(b);
      if (b.size <= target) lo = s; else hi = s;
    }
  }
  if (!best) throw new Error(`Najmniejszy obraz, jaki wyszedł, ma ${fmt(smallest + overhead)} (przy bardzo małej rozdzielczości). Wybierz większą wagę.`);
  return best;
}

let heicLoaded = null;
function loadHeic2any() {
  heicLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HEIC2ANY_URL;
    s.onload = () => resolve(window.heic2any);
    s.onerror = () => reject(new Error('Nie udało się pobrać dekodera HEIC.'));
    document.head.append(s);
  });
  return heicLoaded;
}

// ---------- audio / video ----------

let ffmpeg = null;
let ffLogs = [];
async function getFFmpeg(onStep) {
  if (ffmpeg) return ffmpeg;
  onStep('Pobieram ffmpeg (ok. 31 MB, tylko za pierwszym razem)…');
  const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
  const { toBlobURL } = await import('./vendor/util/index.js');
  const ff = new FFmpeg();
  ff.on('log', ({ message }) => ffLogs.push(message));
  ff.on('progress', ({ progress }) => setProgress(Math.min(1, Math.max(0, progress))));
  // The multi-threaded core needs SharedArrayBuffer, i.e. a cross-origin isolated page.
  const core = ffThreads ? FFMPEG_CORE_MT : FFMPEG_CORE;
  await ff.load({
    coreURL: await toBlobURL(`${core}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${core}/ffmpeg-core.wasm`, 'application/wasm'),
    ...(ffThreads && { workerURL: await toBlobURL(`${core}/ffmpeg-core.worker.js`, 'text/javascript') }),
  });
  return (ffmpeg = ff);
}

async function probe(ff, input) {
  ffLogs = [];
  await ff.exec(['-hide_banner', '-i', input]);
  const log = ffLogs.join('\n');
  const d = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = log.split('\n').find((l) => /Stream .*Video:/.test(l) && !/attached pic/.test(l));
  const dims = video?.match(/, (\d{2,5})x(\d{2,5})/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasVideo: Boolean(video),
    hasAudio: /Stream .*Audio:/.test(log),
    height: dims ? Number(dims[2]) : null,
  };
}

const MP3_RATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

async function shrinkMedia(file, ext, target, onStep) {
  if (file.size > MEDIA_MAX) throw new Error('Plik jest za duży do przekodowania w przeglądarce (limit ok. 1,5 GB).');
  const ff = await getFFmpeg(onStep);
  const input = `in.${ext || 'bin'}`;
  onStep('Wczytuję plik…');
  await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));
  try {
    const info = await probe(ff, input);
    if (!info.duration) throw new Error('ffmpeg nie odczytał długości nagrania. Ten format może być nieobsługiwany.');
    const threads = ffThreads ? ['-threads', String(ffThreads)] : [];
    // One-pass x264 drifts a few percent, so aim below the target to avoid a second full encode.
    const totalBps = (target * 8 * (is('video', ext) ? 0.92 : 0.96)) / info.duration;
    const asVideo = is('video', ext) && info.hasVideo;

    if (!asVideo) {
      const m4a = ext === 'm4a' || ext === 'aac';
      const out = m4a ? 'out.m4a' : 'out.mp3';
      let kbps = Math.floor(totalBps / 1000);
      if (!m4a) kbps = MP3_RATES.filter((r) => r <= kbps).pop();
      if (!kbps || kbps < 8) throw new Error('Ta waga jest za mała na tak długie nagranie.');
      kbps = Math.min(kbps, 320);
      for (let attempt = 1; attempt <= 3; attempt++) {
        onStep(`Przekodowuję audio do ${m4a ? 'M4A' : 'MP3'}, ${kbps} kb/s (próba ${attempt})…`);
        setProgress(0);
        await ff.exec(['-hide_banner', '-i', input, ...threads, '-vn', '-c:a', m4a ? 'aac' : 'libmp3lame', '-b:a', `${kbps}k`, '-y', out]);
        const data = await ff.readFile(out);
        await ff.deleteFile(out);
        if (data.length <= target) return { data, ext: m4a ? 'm4a' : 'mp3' };
        const next = Math.floor(kbps * (target / data.length) * 0.95);
        kbps = m4a ? next : MP3_RATES.filter((r) => r <= next).pop();
        if (!kbps || kbps < 8) break;
      }
      throw new Error('Nie udało się zmieścić nagrania w tej wadze.');
    }

    let audio = !info.hasAudio ? 0 : totalBps > 2e6 ? 128 : totalBps > 5e5 ? 96 : totalBps > 1.5e5 ? 64 : 32;
    let video = (totalBps / 1000) - audio;
    if (video < 40) throw new Error('Ta waga jest za mała na tak długie wideo.');
    for (let attempt = 1; attempt <= 4; attempt++) {
      const v = Math.floor(video);
      const cap = v < 350 ? 360 : v < 800 ? 480 : v < 1800 ? 720 : v < 4000 ? 1080 : null;
      const scale = cap && info.height && info.height > cap ? ['-vf', `scale=-2:${cap}`] : [];
      onStep(`Przekodowuję wideo: ${v} kb/s${scale.length ? `, ${cap}p` : ''} (próba ${attempt}). Przy dużych plikach to trwa, nie zamykaj karty.`);
      setProgress(0);
      await ff.exec([
        '-hide_banner', '-i', input, ...scale, ...threads,
        '-c:v', 'libx264', '-preset', ffThreads ? 'veryfast' : 'superfast', '-pix_fmt', 'yuv420p',
        '-b:v', `${v}k`, '-maxrate', `${v}k`, '-bufsize', `${v * 2}k`,
        ...(audio ? ['-c:a', 'aac', '-b:a', `${audio}k`] : ['-an']),
        '-movflags', '+faststart', '-y', 'out.mp4',
      ]);
      const data = await ff.readFile('out.mp4');
      await ff.deleteFile('out.mp4');
      if (!data.length) throw new Error('ffmpeg nie zapisał wyniku. Ten format może być nieobsługiwany.');
      if (data.length <= target) return { data, ext: 'mp4' };
      video *= (target / data.length) * 0.94;
      if (video < 40) break;
    }
    throw new Error('Nie udało się zmieścić wideo w tej wadze.');
  } finally {
    try { await ff.deleteFile(input); } catch { /* terminated or already gone */ }
  }
}

// ---------- PDF ----------

// Level 0 only rewrites the structure (fonts, streams, duplicate images); higher levels
// recompress images to JPEG at a lower resolution. Text and vectors stay intact.
const PDF_LEVELS = [null, [300, 0.4], [200, 0.6], [150, 0.76], [110, 0.9], [72, 1.3], [50, 2]];

function pdfSettings(level) {
  const args = [
    '-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dCompatibilityLevel=1.6',
    '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
  ];
  const step = PDF_LEVELS[level];
  if (!step) {
    args.push('-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false');
    return { args, ps: null };
  }
  const [res, q] = step;
  args.push(
    '-dDownsampleColorImages=true', '-dDownsampleGrayImages=true', '-dDownsampleMonoImages=true',
    '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${res}`, `-dGrayImageResolution=${res}`, `-dMonoImageResolution=${Math.max(res * 2, 300)}`,
    '-dColorImageDownsampleThreshold=1.0', '-dGrayImageDownsampleThreshold=1.0',
    '-dPassThroughJPEGImages=false', '-dPassThroughJPXImages=false',
    '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false',
    '-dColorImageFilter=/DCTEncode', '-dGrayImageFilter=/DCTEncode',
  );
  const dict = `<< /QFactor ${q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
  return { args, ps: `<< /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams` };
}

let pdfWorker = null;
let pdfJobId = 0;

function runGhostscript(input, level, onPage) {
  pdfWorker ??= new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' });
  const id = ++pdfJobId;
  const { args, ps } = pdfSettings(level);
  return new Promise((resolve, reject) => {
    let total = 0;
    const worker = pdfWorker;
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'pages') total = data.total;
      else if (data.type === 'page') onPage(data.page, total);
      else {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        data.type === 'done' ? resolve(data.bytes) : reject(new Error(data.message));
      }
    };
    const onError = (e) => reject(new Error(e.message || 'Nie udało się uruchomić Ghostscript.'));
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.cancel = () => reject(new Error('terminate'));
    worker.postMessage({ id, args, ps, input: input.slice() });
  });
}

async function shrinkPdf(file, target, onStep) {
  const input = new Uint8Array(await file.arrayBuffer());
  const tried = {};
  let attempt = 0;
  const run = async (level) => {
    attempt++;
    const label = level ? `kompresja obrazów ${level}/${PDF_LEVELS.length - 1}` : 'porządkowanie struktury';
    onStep(`PDF: ${label} (próba ${attempt})${attempt === 1 ? '. Pierwsze użycie pobiera Ghostscript, ok. 15 MB' : ''}…`);
    setProgress(0);
    const out = await runGhostscript(input, level, (page, total) => {
      if (total) setProgress(page / total);
      onStep(`PDF: ${label} (próba ${attempt}), strona ${page}${total ? ` z ${total}` : ''}…`);
    });
    return (tried[level] = out);
  };
  const fits = (level) => tried[level].length <= target;

  if ((await run(0)).length <= target) return tried[0];
  // Smallest level that fits = the best quality that still fits.
  let lo = 1, hi = PDF_LEVELS.length - 1, best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    await run(mid);
    if (fits(mid)) { best = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (best == null) {
    const smallest = Math.min(...Object.values(tried).map((b) => b.length));
    throw new Error(`Najmocniej skompresowany PDF ma ${fmt(smallest)}. Mniej się nie da bez usuwania stron albo tekstu.`);
  }
  return tried[best];
}

// ---------- generate ----------

async function canvasImage(mime) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 64, 64);
  g.addColorStop(0, '#2f6fed');
  g.addColorStop(1, '#13c2a3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const blob = await new Promise((r) => c.toBlob(r, mime, 0.9));
  return blob && blob.type === mime ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function minimalPdf() {
  const text = 'BT /F1 24 Tf 72 760 Td (Plik testowy) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: encoder.encode(pdf), startxref: String(xref) };
}

function wavHeader(dataBytes) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 8000, true); h.setUint32(28, 8000, true); h.setUint16(32, 1, true); h.setUint16(34, 8, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const APP_XML = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>file-size-tool</Application></Properties>`;

function officeEntries(kind) {
  const main = kind === 'xlsx'
    ? { part: 'xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' }
    : { part: 'word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' };
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/${main.part}" ContentType="${main.type}"/>`
      + (kind === 'xlsx' ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : '')
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>',
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="${main.part}"/>`
      + `<Relationship Id="rId2" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`
      + '</Relationships>',
    'docProps/app.xml': APP_XML,
  };
  if (kind === 'xlsx') {
    files['xl/workbook.xml'] = `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">`
      + '<sheets><sheet name="Arkusz1" sheetId="1" r:id="rId1"/></sheets></workbook>';
    files['xl/_rels/workbook.xml.rels'] = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    files['xl/worksheets/sheet1.xml'] = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Plik testowy</t></is></c></row></sheetData></worksheet>';
  } else {
    files['word/document.xml'] = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
      + '<w:body><w:p><w:r><w:t>Plik testowy</w:t></w:r></w:p></w:body></w:document>';
  }
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)]));
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const rels = (...list) => `${XML}<Relationships xmlns="${NS_PKG}">${list
  .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

// Smallest PPTX PowerPoint accepts: one slide, one blank layout, master and theme.
function pptxEntries() {
  const ns = `xmlns:a="${NS_A}" xmlns:r="${REL}" xmlns:p="${NS_P}"`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const colors = [['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '44546A'], ['lt2', 'E7E6E6'], ['accent1', '4472C4'],
    ['accent2', 'ED7D31'], ['accent3', 'A5A5A5'], ['accent4', 'FFC000'], ['accent5', '5B9BD5'], ['accent6', '70AD47'],
    ['hlink', '0563C1'], ['folHlink', '954F72']].map(([n, c]) => `<a:${n}><a:srgbClr val="${c}"/></a:${n}>`).join('');
  const font = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="${PML}.slide+xml"/>`
      + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/>`
      + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/>`
      + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>',
    '_rels/.rels': rels(['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'extended-properties', 'docProps/app.xml']),
    'docProps/app.xml': APP_XML,
    'ppt/presentation.xml': `${XML}<p:presentation ${ns}>`
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
      + '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels(['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'theme', 'theme/theme1.xml']),
    'ppt/slides/slide1.xml': `${XML}<p:sld ${ns}><p:cSld>${EMPTY_TREE}`
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Tekst"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="8000000" cy="1200000"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="pl-PL" sz="4000"/><a:t>Plik testowy</a:t></a:r></a:p></p:txBody>'
      + '</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']),
    'ppt/slideLayouts/slideLayout1.xml': `${XML}<p:sldLayout ${ns} type="blank" preserve="1">`
      + `<p:cSld name="Pusty">${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']),
    'ppt/slideMasters/slideMaster1.xml': `${XML}<p:sldMaster ${ns}><p:cSld>`
      + '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
      + `${EMPTY_TREE}</p:spTree></p:cSld>`
      + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
      + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
      + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml']),
    'ppt/theme/theme1.xml': `${XML}<a:theme xmlns:a="${NS_A}" name="Motyw"><a:themeElements>`
      + `<a:clrScheme name="Office">${colors}</a:clrScheme>`
      + `<a:fontScheme name="Office"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>`
      + `<a:fmtScheme name="Office"><a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst>`
      + `<a:lnStyleLst>${`<a:ln w="6350">${solid}</a:ln>`.repeat(3)}</a:lnStyleLst>`
      + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
      + `<a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>`
      + '</a:themeElements></a:theme>',
  };
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)]));
}

// Minimal OpenDocument file (LibreOffice): mimetype first and stored, then manifest, content and meta.
function odfEntries(kind) {
  const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    + 'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"';
  const mime = `application/vnd.oasis.opendocument.${kind === 'ods' ? 'spreadsheet' : 'text'}`;
  const body = kind === 'ods'
    ? '<office:spreadsheet><table:table table:name="Arkusz1"><table:table-row><table:table-cell office:value-type="string">'
      + '<text:p>Plik testowy</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>'
    : '<office:text><text:p>Plik testowy</text:p></office:text>';
  const files = {
    mimetype: mime,
    'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
      + `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${mime}"/>`
      + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
      + '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>'
      + '</manifest:manifest>',
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ns}><office:body>${body}</office:body></office:document-content>`,
    'meta.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${ns}><office:meta>`
      + '<meta:generator>file-size-tool</meta:generator></office:meta></office:document-meta>',
  };
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)]));
}

// 64x64 24-bit BMP with a gradient; anything after the pixel data is ignored by viewers.
function bmpImage() {
  const w = 64, h = 64, row = w * 3, size = 54 + row * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  dv.setUint32(2, size, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  dv.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.set([0xed, 0x6f + x, 0x2f + y], 54 + y * row + x * 3);
  }
  return out;
}

const HTML = '<!doctype html>\n<html lang="pl"><meta charset="utf-8"><title>Plik testowy</title><p>Plik testowy</p></html>\n';
const RTF = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs28 Plik testowy\\par}\n';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" fill="#2f6fed"/></svg>\n';

const ZIP_GENERATORS = {
  xlsx: () => officeEntries('xlsx'),
  docx: () => officeEntries('docx'),
  pptx: pptxEntries,
  odt: () => odfEntries('odt'),
  ods: () => odfEntries('ods'),
  zip: () => ({ 'czytaj-mnie.txt': encoder.encode('Archiwum testowe wygenerowane w file-size-tool.\n') }),
};

const VALID_GENERATE = set(...Object.keys(ZIP_GENERATORS), 'pdf', 'heic', 'mp4', 'm4v', 'mov', 'mp3', 'gif', 'wav',
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'rtf', 'svg');

async function generate(ext, target, fill) {
  if (ZIP_GENERATORS[ext]) {
    await loadFflate();
    const entries = ZIP_GENERATORS[ext]();
    const zip = zipToExact(entries, 6, target);
    if (!zip) throw new Error(`Najmniejszy poprawny plik .${ext} ma ${fmtBytes(buildZip(entries, 6, 0).length)}. Wybierz większą wagę.`);
    return { parts: [zip], valid: true };
  }
  if (ext === 'wav') {
    if (target < 45) throw new Error('Najmniejszy poprawny plik WAV ma 45 B.');
    return { parts: [wavHeader(target - 44), ...fillParts(target - 44, fill === 'random' ? 'random' : 'silence')], valid: true };
  }
  let head = null;
  let startxref = null;
  if (ext === 'pdf') ({ bytes: head, startxref } = minimalPdf());
  else if (TEMPLATES[ext === 'm4v' ? 'mp4' : ext]) head = b64(TEMPLATES[ext === 'm4v' ? 'mp4' : ext]);
  else if (ext === 'png') head = await canvasImage('image/png');
  else if (ext === 'jpg' || ext === 'jpeg') head = await canvasImage('image/jpeg');
  else if (ext === 'webp') head = await canvasImage('image/webp');
  else if (ext === 'bmp') head = bmpImage();
  else if (ext === 'rtf') head = encoder.encode(RTF);
  else if (ext === 'svg') head = encoder.encode(SVG);
  else if (ext === 'xml') head = encoder.encode(`${XML}<plik-testowy>Plik testowy</plik-testowy>\n`);
  else if (ext === 'json') head = encoder.encode('{"plik": "testowy"}\n');
  else if (ext === 'html' || ext === 'htm') head = encoder.encode(HTML);

  if (!head) return { parts: fillParts(target, is('text', ext) ? textFill(fill) : fill), valid: is('text', ext) };
  if (head.length > target) throw new Error(`Najmniejszy poprawny plik .${ext} ma ${fmtBytes(head.length)}. Wybierz większą wagę.`);
  if (ext === 'mp3') return { parts: [await padMp3(new Blob([head]), target - head.length, fill)], valid: true };
  return { parts: [head, ...trailingPadding(target - head.length, ext, fill, startxref)], valid: true };
}

// ---------- UI ----------

function setProgress(p) {
  els.sBar.style.width = p == null ? '0' : `${Math.round(p * 100)}%`;
  els.sBar.parentElement.classList.toggle('indeterminate', p == null && busy);
}

function startStatus(text) {
  busy = true;
  els.gRun.disabled = true;
  els.rRun.disabled = true;
  els.status.hidden = false;
  els.sResult.hidden = true;
  els.sResult.textContent = '';
  els.sText.textContent = text;
  setProgress(null);
  revealStatus();
}

function endStatus() {
  busy = false;
  els.gRun.disabled = false;
  els.sCancel.hidden = true;
  els.sText.textContent = '';
  els.sBar.parentElement.classList.remove('indeterminate');
  updateResizeNote();
}

// On small screens the status card can sit below the fold.
function revealStatus() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.status.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

function showResult(blob, name, extra = '', fromSize = null) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const ok = document.createElement('div');
  ok.className = 'ok';
  const size = document.createElement('b');
  size.textContent = fmt(blob.size);
  let change = '';
  if (fromSize) {
    const pct = Math.round((blob.size / fromSize - 1) * 100);
    change = ` Było ${fmt(fromSize)}, zmiana ${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%.`;
  }
  ok.append(`Gotowe: ${name}, `, size, ` (${fmtBytes(blob.size)}).${change}${extra ? ` ${extra}` : ''}`);
  // The same bytes read differently depending on whether 1 MB is 1000 or 1024 KB.
  const sides = document.createElement('small');
  sides.className = 'sides';
  sides.textContent = `Finder (macOS): ${fmt(blob.size, 1000)} · Windows, Chrome: ${fmt(blob.size, 1024)}`;
  ok.append(sides);
  const a = document.createElement('a');
  a.className = 'primary';
  a.href = resultUrl;
  a.download = name;
  a.textContent = 'Pobierz ponownie';
  els.sResult.replaceChildren(ok, a);
  els.sResult.hidden = false;
  setProgress(1);
  a.click();
  revealStatus();
}

function showError(err) {
  const div = document.createElement('div');
  div.className = 'err';
  const message = err?.message || String(err);
  div.textContent = /terminate/i.test(message) ? 'Przerwano.' : message;
  els.sResult.replaceChildren(div);
  els.sResult.hidden = false;
  setProgress(null);
  revealStatus();
}

function setNote(el, text, kind = '') {
  el.textContent = text;
  el.className = `note ${kind}`.trim();
}

function selectedExt() {
  const value = els.gExtSelect.value;
  return value === 'other' ? cleanExt(els.gExt.value) : value;
}

function updateGenerateNote() {
  const ext = selectedExt();
  const size = parseSize(els.gSize.value, els.gUnit.value);
  if (!ext) return setNote(els.gNote, 'Wpisz własne rozszerzenie, np. mp4.', 'warn');
  if (!size) return setNote(els.gNote, 'Wpisz wagę większą od zera.', 'warn');
  const exact = `Plik będzie miał dokładnie ${fmtBytes(size)}.`;
  // Office, ZIP, JSON and RTF accept only spaces as padding, so there is nothing to choose.
  els.gFillField.hidden = Boolean(ZIP_GENERATORS[ext]) || WHITESPACE_ONLY.has(ext);
  if (VALID_GENERATE.has(ext) || is('text', ext)) {
    setNote(els.gNote, `${exact} Dla .${ext} powstanie poprawny plik, który się otworzy (z małą zawartością testową), dopełniony do tej wagi.`);
  } else {
    setNote(els.gNote, `${exact} Dla .${ext} plik będzie miał właściwą nazwę i wagę, ale w środku tylko wypełnienie, więc żaden program go nie otworzy. Do testów limitów uploadu zwykle wystarcza.`, 'warn');
  }
}

function resizePlan() {
  if (!currentFile) return null;
  const target = parseSize(els.rSize.value, els.rUnit.value);
  if (!target) return { kind: 'none' };
  const { ext } = splitName(currentFile.name);
  const size = currentFile.size;
  if (target === size) return { kind: 'same', target, ext };
  if (target > size) return { kind: 'grow', target, ext };
  if (is('heic', ext)) return { kind: 'heic', target, ext };
  if (is('image', ext)) return { kind: 'image', target, ext };
  if (is('video', ext) || is('audio', ext)) return { kind: 'media', target, ext };
  if (isZipLike(ext)) return { kind: 'zip', target, ext };
  if (ext === 'pdf') return { kind: 'pdf', target, ext };
  return { kind: 'unsupported', target, ext };
}

function updateResizeNote() {
  const plan = resizePlan();
  els.rRun.disabled = busy || !plan || ['none', 'same', 'unsupported'].includes(plan.kind);
  if (!plan) return setNote(els.rNote, '');
  const ext = plan.ext;
  const growNotes = () => {
    if (is('officeZip', ext)) return [`Plik .${ext} to w środku archiwum ZIP. Dopiszę puste znaki do jednego z plików XML w środku, więc dalej będzie się otwierał.`];
    if (is('zip', ext)) return ['Dodam do archiwum plik padding.bin z zerami.'];
    if (is('isobmff', ext)) return ['Dopiszę na końcu pusty blok „free”, który odtwarzacze i przeglądarki zdjęć pomijają.'];
    if (ext === 'pdf') return ['Dopiszę na końcu komentarz PDF i powtórzę odnośnik do tabeli obiektów, więc PDF się otworzy.'];
    if (is('ole', ext)) return [`Stary format .${ext} może zgłosić błąd po dopisaniu bajtów. Jeśli to możliwe, zapisz go najpierw jako ${ext}x.`, 'warn'];
    if (is('text', ext)) return ['Dopiszę na końcu spacje.'];
    return ['Dopiszę puste bajty na końcu pliku. JPG, PNG, GIF, MP3 i większość formatów to ignoruje.'];
  };
  const notes = {
    none: ['Wpisz docelową wagę.'],
    same: ['Plik ma już dokładnie tę wagę.', 'warn'],
    grow: growNotes(),
    image: [`Przekompresuję obraz: najpierw obniżę jakość, a jeśli to nie wystarczy, rozdzielczość. ${ext === 'jpg' || ext === 'jpeg'
      ? 'Nazwa i dane zdjęcia (aparat, data, lokalizacja) zostają.'
      : 'Nazwa zostaje, dane zdjęcia (EXIF) zostaną usunięte.'}`],
    heic: ['Przeglądarka nie potrafi zapisać HEIC, więc zmniejszony plik będzie w formacie JPG. Metadane zostaną usunięte.', 'warn'],
    media: is('video', ext)
      ? ['Przekoduję wideo do MP4 (H.264 + AAC) z bitrate dobranym do wagi. Duże pliki liczą się długo, zostaw kartę otwartą.']
      : [`Przekoduję nagranie do ${ext === 'm4a' || ext === 'aac' ? 'M4A' : 'MP3'} z bitrate dobranym do wagi.`],
    zip: is('officeZip', ext)
      ? ['Spakuję plik mocniej, a jeśli to za mało, zmniejszę zdjęcia w środku. Tekst i dane zostają bez zmian.']
      : ['Spakuję archiwum mocniej, bez zmiany zawartości. Jeśli to za mało, bardziej się nie da.'],
    pdf: ['Przepiszę PDF przez Ghostscript. Tekst i grafika wektorowa zostają bez zmian, a zdjęcia stracą na jakości i rozdzielczości tylko tyle, ile trzeba. PDF zabezpieczony hasłem nie zadziała.'],
    unsupported: [`Pliku .${ext || '(bez rozszerzenia)'} nie da się zmniejszyć w przeglądarce bez uszkodzenia. Obsługiwane: PDF, zdjęcia (jpg, png, webp, heic), wideo, audio, pliki Office (xlsx, docx, pptx) i ZIP.`, 'err'],
  };
  const [text, kind] = notes[plan.kind];
  setNote(els.rNote, `${text}${plan.target && plan.kind !== 'same' ? ` Cel: ${fmtBytes(plan.target)}.` : ''}`, kind);
}

function setFile(file) {
  currentFile = file;
  els.drop.classList.toggle('has-file', !!file);
  els.rPresets.hidden = !file;
  els.dropTitle.textContent = file ? file.name : 'Upuść plik tutaj';
  els.dropSub.textContent = file
    ? `${fmt(file.size)} (${fmtBytes(file.size)}). Kliknij albo upuść inny, żeby zmienić.`
    : 'albo kliknij, żeby wybrać';
  markPreset(els.rPresets);
  updateResizeNote();
}

// ---------- quick sizes ----------

// Writes bytes into a size field using the largest unit that keeps the number readable.
function setSizeField(input, unitSelect, bytes) {
  let unit = 0;
  while (unit < 3 && bytes >= base() ** (unit + 1)) unit++;
  const value = Math.round((bytes / base() ** unit) * 100) / 100;
  input.value = value.toLocaleString('pl-PL', { maximumFractionDigits: 2, useGrouping: false });
  unitSelect.value = String(unit);
}

// Highlights the chip that matches the current field value, if any.
function markPreset(box) {
  const gen = box === els.gPresets;
  const target = gen ? parseSize(els.gSize.value, els.gUnit.value) : parseSize(els.rSize.value, els.rUnit.value);
  for (const chip of box.querySelectorAll('button')) {
    const bytes = chip.dataset.factor
      ? (currentFile ? Math.round(currentFile.size * Number(chip.dataset.factor)) : null)
      : parseSize(chip.dataset.size, chip.dataset.unit);
    const near = target && bytes && Math.abs(target - bytes) <= Math.max(1, bytes * 0.005);
    chip.setAttribute('aria-pressed', String(!!near));
  }
}

function onPreset(box, input, unitSelect, after) {
  box.addEventListener('click', (e) => {
    const chip = e.target.closest('button');
    if (!chip) return;
    if (chip.dataset.factor) {
      if (!currentFile) return;
      setSizeField(input, unitSelect, Math.round(currentFile.size * Number(chip.dataset.factor)));
    } else {
      input.value = chip.dataset.size;
      unitSelect.value = chip.dataset.unit;
    }
    after();
    markPreset(box);
  });
}

async function runGenerate() {
  const ext = selectedExt();
  const target = parseSize(els.gSize.value, els.gUnit.value);
  if (!ext || !target) return updateGenerateNote();
  const name = `${cleanStem(els.gName.value)}.${ext}`;
  startStatus(`Generuję ${name}…`);
  try {
    const { parts, valid } = await generate(ext, target, checked(els.gFill));
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    if (blob.size !== target) throw new Error(`Błąd: wyszło ${fmtBytes(blob.size)} zamiast ${fmtBytes(target)}.`);
    showResult(blob, name, valid ? '' : 'Plik ma tylko wypełnienie, nie otworzy się w programie.');
  } catch (err) {
    showError(err);
  } finally {
    endStatus();
  }
}

async function runResize() {
  const plan = resizePlan();
  if (!plan || ['none', 'same', 'unsupported'].includes(plan.kind)) return;
  const file = currentFile;
  const exact = els.rExact.checked || plan.kind === 'grow';
  const { stem, ext } = splitName(file.name);
  const onStep = (t) => { els.sText.textContent = t; };
  startStatus('Przygotowuję…');
  try {
    let outBlob;
    let outExt = ext;
    let extra = '';

    if (plan.kind === 'grow' && isZipLike(ext)) {
      onStep('Przepakowuję archiwum…');
      outBlob = new Blob([await growZip(new Uint8Array(await file.arrayBuffer()), plan.target)]);
    } else if (plan.kind === 'grow') {
      outBlob = await padTo(file, plan.target, ext);
    } else if (plan.kind === 'zip') {
      outBlob = new Blob([await shrinkZip(new Uint8Array(await file.arrayBuffer()), ext, plan.target, exact, onStep)]);
    } else if (plan.kind === 'image' || plan.kind === 'heic') {
      let source = file;
      let mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      if (plan.kind === 'heic') {
        onStep('Dekoduję HEIC…');
        const heic2any = await loadHeic2any();
        const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
        source = Array.isArray(converted) ? converted[0] : converted;
        mime = 'image/jpeg';
        outExt = 'jpg';
        extra = 'HEIC zapisany jako JPG.';
      }
      const meta = plan.kind === 'image' && mime === 'image/jpeg' ? await jpegMeta(file) : [];
      let metaSize = meta.reduce((sum, s) => sum + s.length, 0);
      if (metaSize >= plan.target / 2) { meta.length = 0; metaSize = 0; }
      outBlob = await withJpegMeta(await shrinkImage(source, mime, plan.target - metaSize, onStep, metaSize), meta);
    } else if (plan.kind === 'media') {
      els.sCancel.hidden = false;
      const { data, ext: e } = await shrinkMedia(file, ext, plan.target, onStep);
      els.sCancel.hidden = true;
      outBlob = new Blob([data]);
      if (e !== ext) extra = `Zapisany jako ${e.toUpperCase()}.`;
      outExt = e;
    } else if (plan.kind === 'pdf') {
      els.sCancel.hidden = false;
      outBlob = new Blob([await shrinkPdf(file, plan.target, onStep)]);
      els.sCancel.hidden = true;
    }

    if (exact && outBlob.size < plan.target && !isZipLike(outExt)) outBlob = await padTo(outBlob, plan.target, outExt);
    showResult(outBlob, outExt === ext ? file.name : `${stem}.${outExt}`, extra, file.size);
  } catch (err) {
    showError(err);
  } finally {
    endStatus();
  }
}

function applyMode() {
  const gen = checked(els.mode) === 'generate';
  els.generate.hidden = !gen;
  els.resize.hidden = gen;
  if (!busy) els.status.hidden = true;
}

function setMode(value) {
  els.mode.querySelector(`input[value="${value}"]`).checked = true;
  applyMode();
}

els.mode.addEventListener('change', applyMode);
[els.gExt, els.gSize, els.gUnit].forEach((el) => el.addEventListener('input', () => {
  updateGenerateNote();
  markPreset(els.gPresets);
}));
els.gExtSelect.addEventListener('change', () => {
  els.gExtCustom.hidden = els.gExtSelect.value !== 'other';
  if (!els.gExtCustom.hidden) els.gExt.focus();
  updateGenerateNote();
});
[els.rSize, els.rUnit].forEach((el) => el.addEventListener('input', () => {
  updateResizeNote();
  markPreset(els.rPresets);
}));
onPreset(els.gPresets, els.gSize, els.gUnit, updateGenerateNote);
onPreset(els.rPresets, els.rSize, els.rUnit, updateResizeNote);
els.gRun.addEventListener('click', runGenerate);
els.rRun.addEventListener('click', runResize);

// Enter in a text field starts the action, like submitting a form.
els.generate.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input') && !busy) runGenerate();
});
els.resize.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[inputmode]') && !els.rRun.disabled) runResize();
});
els.rFile.addEventListener('change', () => setFile(els.rFile.files[0] ?? null));
els.sCancel.addEventListener('click', () => {
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
  }
  if (pdfWorker) {
    pdfWorker.cancel?.();
    pdfWorker.terminate();
    pdfWorker = null;
  }
});

['dragenter', 'dragover'].forEach((t) => els.drop.addEventListener(t, (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => els.drop.addEventListener(t, (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
}));
els.drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

// A file dropped anywhere on the page switches to resizing it.
let dragDepth = 0;
const draggingFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!draggingFiles(e)) return;
  dragDepth++;
  if (!busy && !els.drop.contains(e.target)) els.pageDrop.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.pageDrop.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (draggingFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.pageDrop.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (!file || busy || els.drop.contains(e.target)) return;
  setMode('resize');
  setFile(file);
  els.rSize.focus();
});

// ---------- theme ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => document.documentElement.dataset.theme
  ? document.documentElement.dataset.theme === 'dark'
  : darkQuery.matches;

function syncThemeButton() {
  const label = isDark() ? 'Włącz tryb jasny' : 'Włącz tryb ciemny';
  els.theme.setAttribute('aria-label', label);
  els.theme.title = label;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = isDark() ? '#111317' : '#f4f5f7';
  }
}

els.theme.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  syncThemeButton();
});
darkQuery.addEventListener('change', syncThemeButton);
syncThemeButton();

// The browser may restore form values after a reload.
applyMode();
els.gExtCustom.hidden = els.gExtSelect.value !== 'other';
updateGenerateNote();
markPreset(els.gPresets);
