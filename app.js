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
  text: set('txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'svg', 'js', 'css', 'log', 'yaml', 'yml'),
  image: set('jpg', 'jpeg', 'png', 'webp'),
  heic: set('heic', 'heif'),
  video: set('mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts'),
  audio: set('mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma'),
};
const is = (family, ext) => FAMILY[family].has(ext);
const isZipLike = (ext) => is('officeZip', ext) || is('zip', ext);

const $ = (id) => document.getElementById(id);
const els = {
  mode: $('mode'), base: $('base'),
  generate: $('generate'), gName: $('g-name'), gExt: $('g-ext'), gSize: $('g-size'), gUnit: $('g-unit'),
  gFill: $('g-fill'), gNote: $('g-note'), gRun: $('g-run'),
  resize: $('resize'), drop: $('drop'), rFile: $('r-file'), rInfo: $('r-info'), rSize: $('r-size'),
  rUnit: $('r-unit'), rExact: $('r-exact'), rNote: $('r-note'), rRun: $('r-run'),
  status: $('status'), sText: $('s-text'), sBar: $('s-bar'), sCancel: $('s-cancel'), sResult: $('s-result'),
};

let busy = false;
let currentFile = null;
let resultUrl = null;

// ---------- helpers ----------

const base = () => Number(els.base.value);

function parseSize(value, unit) {
  const n = parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * base() ** Number(unit));
}

function fmt(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= base() && i < units.length - 1) { v /= base(); i++; }
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
  return value.trim().replace(/[\\/:*?"<>|]/g, '-') || 'plik';
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
      return [head, ...fillParts(n - head.length - tail.length, 'space'), tail];
    }
  }
  if (is('text', ext)) return fillParts(n, kind === 'zero' ? 'space' : kind);
  return fillParts(n, kind);
}

// MP3: padding goes into an ID3v2 tag at the start (players skip it and the duration stays right).
const ID3_MAX = 2 ** 28 - 1;
const syncsafe = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];

async function padMp3(blob, n, kind) {
  if (n <= 0) return blob;
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  const hasTag = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && !(head[5] & 0x10);
  if (hasTag) {
    const old = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    if (old + n <= ID3_MAX) {
      const header = Uint8Array.from([...head.subarray(0, 6), ...syncsafe(old + n)]);
      return new Blob([header, blob.slice(10, 10 + old), ...fillParts(n, 'zero'), blob.slice(10 + old)]);
    }
  } else if (n >= 10 && n - 10 <= ID3_MAX) {
    const header = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(n - 10)]);
    return new Blob([header, ...fillParts(n - 10, 'zero'), blob]);
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
        if (size <= target) { bestEntries = candidate; hi = t; } else if (i === 0) break; else lo = t;
      }
      if (bestEntries) {
        Object.assign(entries, bestEntries);
        best = buildZip(entries, 9, 0);
      }
    }
  }
  if (best.length > target) {
    throw new Error(`Po mocniejszym spakowaniu plik ma ${fmt(best.length)}. Mniej się nie da bez usuwania zawartości.`);
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

async function shrinkImage(blob, mime, target, onStep) {
  const bitmap = await createImageBitmap(blob);
  let best = null;
  const keep = (b) => { if (b && b.size <= target && (!best || b.size > best.size)) best = b; };
  if (mime !== 'image/png') {
    let lo = 0.05, hi = 0.95;
    for (let i = 0; i < 8; i++) {
      onStep(`Dobieram jakość (próba ${i + 1})…`);
      const q = (lo + hi) / 2;
      const b = await encodeBitmap(bitmap, 1, mime, q);
      if (b.size <= target) { keep(b); lo = q; } else hi = q;
    }
  }
  if (!best) {
    let lo = 0.03, hi = 1;
    for (let i = 0; i < 9; i++) {
      onStep(`Dobieram rozdzielczość (próba ${i + 1})…`);
      const s = (lo + hi) / 2;
      const b = await encodeBitmap(bitmap, s, mime, 0.8);
      if (b.size <= target) { keep(b); lo = s; } else hi = s;
    }
  }
  if (!best) throw new Error('Nie udało się zmieścić obrazu w tej wadze.');
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

const VALID_GENERATE = set('xlsx', 'docx', 'zip', 'pdf', 'heic', 'mp4', 'm4v', 'mov', 'mp3', 'gif', 'wav', 'png', 'jpg', 'jpeg', 'webp');

async function generate(ext, target, fill) {
  if (ext === 'xlsx' || ext === 'docx' || ext === 'zip') {
    await loadFflate();
    const entries = ext === 'zip'
      ? { 'czytaj-mnie.txt': encoder.encode('Archiwum testowe wygenerowane w file-size-tool.\n') }
      : officeEntries(ext);
    const zip = zipToExact(entries, 6, target);
    if (!zip) throw new Error(`Najmniejszy poprawny plik .${ext} waży więcej niż ${fmt(target)}.`);
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

  if (!head) return { parts: fillParts(target, is('text', ext) && fill === 'zero' ? 'space' : fill), valid: is('text', ext) };
  if (head.length > target) throw new Error(`Najmniejszy poprawny plik .${ext} ma ${fmtBytes(head.length)}. Wybierz większą wagę.`);
  if (ext === 'mp3') return { parts: [await padMp3(new Blob([head]), target - head.length, fill)], valid: true };
  return { parts: [head, ...trailingPadding(target - head.length, ext, fill, startxref)], valid: true };
}

// ---------- UI ----------

function setProgress(p) {
  els.sBar.style.width = p == null ? '0' : `${Math.round(p * 100)}%`;
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
}

function endStatus() {
  busy = false;
  els.gRun.disabled = false;
  els.sCancel.hidden = true;
  els.sText.textContent = '';
  updateResizeNote();
}

function showResult(blob, name, extra = '') {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const ok = document.createElement('div');
  ok.className = 'ok';
  ok.textContent = `Gotowe: ${name}, ${fmt(blob.size)} (${fmtBytes(blob.size)}).${extra ? ` ${extra}` : ''}`;
  const a = document.createElement('a');
  a.className = 'primary';
  a.href = resultUrl;
  a.download = name;
  a.textContent = 'Pobierz plik';
  els.sResult.replaceChildren(ok, a);
  els.sResult.hidden = false;
  setProgress(1);
  a.click();
}

function showError(err) {
  const div = document.createElement('div');
  div.className = 'err';
  const message = err?.message || String(err);
  div.textContent = /terminate/i.test(message) ? 'Przerwano.' : message;
  els.sResult.replaceChildren(div);
  els.sResult.hidden = false;
  setProgress(null);
}

function setNote(el, text, kind = '') {
  el.textContent = text;
  el.className = `note ${kind}`.trim();
}

function updateGenerateNote() {
  const ext = cleanExt(els.gExt.value);
  const size = parseSize(els.gSize.value, els.gUnit.value);
  if (!ext) return setNote(els.gNote, 'Wpisz rozszerzenie, np. xlsx, heic albo pdf.', 'warn');
  if (!size) return setNote(els.gNote, 'Wpisz wagę większą od zera.', 'warn');
  const exact = `Plik będzie miał dokładnie ${fmtBytes(size)}.`;
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
    image: ['Przekompresuję obraz: najpierw obniżę jakość, a jeśli to nie wystarczy, rozdzielczość. Metadane (EXIF, lokalizacja) zostaną usunięte.'],
    heic: ['Przeglądarka nie potrafi zapisać HEIC, więc zmniejszony plik będzie w formacie JPG. Metadane zostaną usunięte.', 'warn'],
    media: is('video', ext)
      ? ['Przekoduję wideo do MP4 (H.264 + AAC) z bitrate dobranym do wagi. Duże pliki liczą się długo, zostaw kartę otwartą.']
      : [`Przekoduję nagranie do ${ext === 'm4a' || ext === 'aac' ? 'M4A' : 'MP3'} z bitrate dobranym do wagi.`],
    zip: is('officeZip', ext)
      ? ['Spakuję plik mocniej, a jeśli to za mało, zmniejszę zdjęcia w środku. Tekst i dane zostają bez zmian.']
      : ['Spakuję archiwum mocniej, bez zmiany zawartości. Jeśli to za mało, bardziej się nie da.'],
    unsupported: [`Pliku .${ext || '(bez rozszerzenia)'} nie da się zmniejszyć w przeglądarce bez uszkodzenia. Obsługiwane: zdjęcia (jpg, png, webp, heic), wideo, audio, pliki Office (xlsx, docx, pptx) i ZIP.`, 'err'],
  };
  const [text, kind] = notes[plan.kind];
  setNote(els.rNote, `${text}${plan.target && plan.kind !== 'same' ? ` Cel: ${fmtBytes(plan.target)}.` : ''}`, kind);
}

function setFile(file) {
  currentFile = file;
  els.rInfo.hidden = !file;
  if (file) {
    els.rInfo.innerHTML = '';
    const name = document.createElement('div');
    name.textContent = file.name;
    const size = document.createElement('div');
    size.innerHTML = `Waga: <b>${fmt(file.size)}</b> (${fmtBytes(file.size)})`;
    els.rInfo.append(name, size);
  }
  updateResizeNote();
}

async function runGenerate() {
  const ext = cleanExt(els.gExt.value);
  const target = parseSize(els.gSize.value, els.gUnit.value);
  if (!ext || !target) return updateGenerateNote();
  const name = `${cleanStem(els.gName.value)}.${ext}`;
  startStatus(`Generuję ${name}…`);
  try {
    const { parts, valid } = await generate(ext, target, els.gFill.value);
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
      outBlob = await shrinkImage(source, mime, plan.target, onStep);
    } else if (plan.kind === 'media') {
      els.sCancel.hidden = false;
      const { data, ext: e } = await shrinkMedia(file, ext, plan.target, onStep);
      els.sCancel.hidden = true;
      outBlob = new Blob([data]);
      if (e !== ext) extra = `Zapisany jako ${e.toUpperCase()}.`;
      outExt = e;
    }

    if (exact && outBlob.size < plan.target && !isZipLike(outExt)) outBlob = await padTo(outBlob, plan.target, outExt);
    showResult(outBlob, `${stem}-${fmt(plan.target).replace(/\s/g, '').replace(',', '_')}.${outExt}`, extra);
  } catch (err) {
    showError(err);
  } finally {
    endStatus();
  }
}

function applyMode() {
  const gen = els.mode.value === 'generate';
  els.generate.hidden = !gen;
  els.resize.hidden = gen;
  if (!busy) els.status.hidden = true;
}
els.mode.addEventListener('change', applyMode);
els.base.addEventListener('change', () => {
  updateGenerateNote();
  setFile(currentFile);
});
[els.gExt, els.gSize, els.gUnit].forEach((el) => el.addEventListener('input', updateGenerateNote));
[els.rSize, els.rUnit].forEach((el) => el.addEventListener('input', updateResizeNote));
els.gRun.addEventListener('click', runGenerate);
els.rRun.addEventListener('click', runResize);
els.rFile.addEventListener('change', () => setFile(els.rFile.files[0] ?? null));
els.sCancel.addEventListener('click', () => {
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
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

// The browser may restore form values after a reload.
applyMode();
updateGenerateNote();
