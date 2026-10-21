import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK, ZIP_MAX, MEDIA_MAX, ID3_MAX, STEP_LADDER,
  base, parseSize, fmt, fmtBytes, splitName, cleanExt, cleanStem,
  fillChunk, fillParts, fillBytes, textFill, trailingPadding, syncsafe, id3Fill, padMp3, findPdfStartxref, padTo,
  planResize, stepFor, nextStep,
} from '../size.js';

const NBSP = ' '; // pl-PL groups thousands with a non-breaking space
const total = (parts) => parts.reduce((sum, p) => sum + p.length, 0);
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const ascii = (u8) => Buffer.from(u8).toString('latin1');

test('1 MB = 1024 KB', () => {
  assert.equal(base(), 1024);
});

test('parseSize: units, comma and dot, spaces', () => {
  assert.equal(parseSize('1', 0), 1);
  assert.equal(parseSize('1', 1), 1024);
  assert.equal(parseSize('1', 2), 1024 ** 2);
  assert.equal(parseSize('1', 3), 1024 ** 3);
  assert.equal(parseSize('95,5', 2), Math.round(95.5 * 1024 ** 2));
  assert.equal(parseSize('95.5', '2'), Math.round(95.5 * 1024 ** 2));
  assert.equal(parseSize(' 1 000 ', 0), 1000);
  assert.equal(parseSize('0,1', 1), 102); // rounded to whole bytes
});

test('parseSize: rejects zero, negatives and garbage', () => {
  for (const v of ['', '0', '-5', 'abc', 'Infinity', '0,0']) assert.equal(parseSize(v, 2), null, v);
});

test('fmt: picks the unit and uses Polish number format', () => {
  assert.equal(fmt(0), '0 B');
  assert.equal(fmt(1023), '1023 B');
  assert.equal(fmt(1024), '1 KB');
  assert.equal(fmt(1536), '1,5 KB');
  assert.equal(fmt(10 * 1024 ** 2), '10 MB');
  assert.equal(fmt(1024 ** 3), '1 GB');
  assert.equal(fmt(5 * 1024 ** 4), '5120 GB'); // GB is the largest unit
  assert.equal(fmt(20 * 1024 ** 4), `20${NBSP}480 GB`);
});

test('fmt: Finder base 1000 vs Windows/Chrome base 1024', () => {
  assert.equal(fmt(10_000_000, 1000), '10 MB');
  assert.equal(fmt(10_000_000, 1024), '9,54 MB');
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(5), '5 B');
  assert.equal(fmtBytes(10485760), `10${NBSP}485${NBSP}760 B`);
});

test('splitName', () => {
  assert.deepEqual(splitName('raport.PDF'), { stem: 'raport', ext: 'pdf' });
  assert.deepEqual(splitName('archiwum.tar.gz'), { stem: 'archiwum.tar', ext: 'gz' });
  assert.deepEqual(splitName('.bashrc'), { stem: '.bashrc', ext: '' });
  assert.deepEqual(splitName('README'), { stem: 'README', ext: '' });
});

test('cleanExt and cleanStem', () => {
  assert.equal(cleanExt('  ..MP4 '), 'mp4');
  assert.equal(cleanExt('tar.gz'), 'tar.gz');
  assert.equal(cleanExt('ex e!'), 'exe');
  assert.equal(cleanStem('  a/b:c*?  '), 'a-b-c--');
  assert.equal(cleanStem('   '), 'plik-testowy');
});

test('limits', () => {
  assert.equal(ZIP_MAX, 0xffffffff - 1024 * 1024);
  assert.equal(MEDIA_MAX, 1.5 * 1024 ** 3);
  assert.equal(ID3_MAX, 2 ** 28 - 1);
  assert.equal(CHUNK, 4 * 1024 * 1024);
});

test('planResize: picks the method per format', () => {
  const plan = (name, size, target) => planResize(name, size, target).kind;
  assert.equal(plan('a.jpg', 100, null), 'none');
  assert.equal(plan('a.jpg', 100, 100), 'same');
  assert.equal(plan('a.jpg', 100, 200), 'grow');
  assert.equal(plan('a.exe', 100, 200), 'grow');
  assert.equal(plan('a.HEIC', 100, 50), 'heic');
  assert.equal(plan('a.jpeg', 100, 50), 'image');
  assert.equal(plan('a.webp', 100, 50), 'image');
  assert.equal(plan('a.mkv', 100, 50), 'media');
  assert.equal(plan('a.flac', 100, 50), 'media');
  assert.equal(plan('a.docx', 100, 50), 'zip');
  assert.equal(plan('a.zip', 100, 50), 'zip');
  assert.equal(plan('a.pdf', 100, 50), 'pdf');
  assert.equal(plan('a.exe', 100, 50), 'unsupported');
  assert.equal(plan('bez-rozszerzenia', 100, 50), 'unsupported');
  assert.deepEqual(planResize('x.Pdf', 100, 50), { kind: 'pdf', target: 50, ext: 'pdf' });
});

test('stepFor: about a tenth of the value, from the ladder', () => {
  assert.equal(stepFor(10, 2), 1);
  assert.equal(stepFor(100, 2), 10);
  assert.equal(stepFor(1, 2), 0.1);
  assert.equal(stepFor(0.3, 2), 0.1);
  assert.equal(stepFor(50, 2), 5);
  assert.equal(stepFor(1e6, 3), 500);
  for (const s of [stepFor(7, 2), stepFor(123, 3)]) assert.ok(STEP_LADDER.includes(s));
});

test('stepFor: B and KB step in whole numbers', () => {
  assert.equal(stepFor(1, 0), 1);
  assert.equal(stepFor(1, 1), 1);
  assert.equal(stepFor(10, 1), 1);
  assert.equal(stepFor(50, 0), 5);
  assert.equal(stepFor(1, '1'), 1); // unit comes from a <select> as a string
});

test('nextStep: up, down, never to zero', () => {
  assert.equal(nextStep(10, 2, 1), 11);
  assert.equal(nextStep(10, 2, -1), 9);
  assert.equal(nextStep(100, 2, 1), 110);
  assert.ok(Math.abs(nextStep(1, 2, -1) - 0.9) < 1e-9);
  assert.equal(nextStep(0.1, 2, -1), 0.1);
  assert.equal(nextStep(1, 0, -1), 1);
  assert.equal(nextStep(1, 1, -1), 1);
});

test('nextStep: bytes stay whole', () => {
  assert.equal(nextStep(12.6, 0, 1), 14);
  assert.ok(Number.isInteger(nextStep(1234.5, 0, -1)));
});

test('fillParts / fillBytes: exactly n bytes, also above one chunk', () => {
  for (const n of [0, 1, 4095, CHUNK, CHUNK + 1, 3 * CHUNK - 7]) {
    assert.equal(total(fillParts(n, 'zero')), n, `parts ${n}`);
  }
  assert.equal(fillBytes(CHUNK + 5, 'space').length, CHUNK + 5);
  assert.ok(fillBytes(100, 'space').every((b) => b === 0x20));
  // Huge sizes reuse one shared chunk, so this costs no memory.
  assert.equal(total(fillParts(5 * 1024 ** 3, 'random')), 5 * 1024 ** 3);
});

test('fill kinds', () => {
  assert.ok(fillChunk('zero').every((b) => b === 0));
  assert.ok(fillChunk('silence').subarray(0, 1000).every((b) => b === 0x80));
  const letters = ascii(fillChunk('letters').subarray(0, 800));
  assert.match(letters, /^([A-Za-z0-9]{79}\n){10}$/);
  const pdf = ascii(fillChunk('pdf-letters').subarray(0, 800));
  assert.match(pdf, /^(%[A-Za-z0-9]{78}\n){10}$/);
  assert.match(ascii(fillChunk('text').subarray(0, 40)), /^Plik testowy/);
  assert.equal(textFill('zero'), 'space');
  assert.equal(textFill('random'), 'letters');
  assert.equal(textFill('text'), 'text');
});

test('trailingPadding: exact length for every format and fill', () => {
  const exts = ['mp4', 'heic', 'pdf', 'svg', 'html', 'json', 'rtf', 'txt', 'csv', 'bin', 'png'];
  for (const ext of exts) {
    for (const kind of ['zero', 'random', 'text']) {
      for (const n of [1, 2, 15, 16, 17, 100, CHUNK + 3]) {
        assert.equal(total(trailingPadding(n, ext, kind, '123')), n, `${ext} ${kind} ${n}`);
      }
    }
  }
  assert.deepEqual(trailingPadding(0, 'mp4', 'zero'), []);
  assert.deepEqual(trailingPadding(-5, 'mp4', 'zero'), []);
});

test('trailingPadding: ISO-BMFF free box, 32- and 64-bit size', () => {
  const [head] = trailingPadding(100, 'mp4', 'zero');
  const dv = new DataView(head.buffer);
  assert.equal(dv.getUint32(0), 100);
  assert.equal(ascii(head.subarray(4, 8)), 'free');

  const n = 2 ** 32 + 10;
  const parts = trailingPadding(n, 'mov', 'zero');
  const big = new DataView(parts[0].buffer);
  assert.equal(parts[0].length, 16);
  assert.equal(big.getUint32(0), 1); // size 1 means "64-bit size follows"
  assert.equal(ascii(parts[0].subarray(4, 8)), 'free');
  assert.equal(big.getUint32(8) * 2 ** 32 + big.getUint32(12), n);
  assert.equal(total(parts), n);
});

test('trailingPadding: PDF repeats startxref at the end', () => {
  const parts = trailingPadding(500, 'pdf', 'random', '987');
  const text = ascii(Buffer.concat(parts));
  assert.ok(text.startsWith('\n%'));
  assert.ok(text.endsWith('\nstartxref\n987\n%%EOF\n'));
});

test('trailingPadding: markup gets a comment, JSON/RTF only spaces', () => {
  const svg = ascii(Buffer.concat(trailingPadding(200, 'svg', 'random')));
  assert.ok(svg.startsWith('\n<!--\n') && svg.endsWith('\n-->\n'));
  assert.ok(!svg.slice(6, -5).includes('--'));
  for (const ext of ['json', 'rtf']) {
    const pad = Buffer.concat(trailingPadding(300, ext, 'random'));
    assert.ok(pad.every((b) => b === 0x20), ext);
  }
});

test('syncsafe: 7 bits per byte', () => {
  assert.deepEqual(syncsafe(0), [0, 0, 0, 0]);
  assert.deepEqual(syncsafe(127), [0, 0, 0, 127]);
  assert.deepEqual(syncsafe(128), [0, 0, 1, 0]);
  assert.deepEqual(syncsafe(ID3_MAX), [127, 127, 127, 127]);
});

test('id3Fill: PRIV frame of exactly n bytes, null when too small', () => {
  assert.equal(total(id3Fill(1000, 3, 'random')), 1000);
  assert.equal(total(id3Fill(1000, 4, 'text')), 1000);
  assert.equal(total(id3Fill(5, 3, 'zero')), 5);
  assert.equal(id3Fill(20, 3, 'random'), null);
  const [header] = id3Fill(1000, 3, 'random');
  assert.equal(ascii(header.subarray(0, 4)), 'PRIV');
});

const id3Size = (h) => (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];

test('padMp3: new ID3 tag in front, audio untouched', async () => {
  const audio = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
  for (const kind of ['zero', 'random', 'text']) {
    const out = await bytesOf(await padMp3(new Blob([audio]), 1000, kind));
    assert.equal(out.length, 1005, kind);
    assert.equal(ascii(out.subarray(0, 3)), 'ID3');
    assert.equal(id3Size(out) + 10, 1000);
    assert.deepEqual(out.subarray(1000), audio);
  }
});

test('padMp3: existing ID3 tag grows in place', async () => {
  const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(4), 0, 0, 0, 0]);
  const audio = new Uint8Array([0xff, 0xfb, 9]);
  const out = await bytesOf(await padMp3(new Blob([tag, audio]), 500, 'random'));
  assert.equal(out.length, tag.length + audio.length + 500);
  assert.equal(id3Size(out), 504);
  assert.deepEqual(out.subarray(-3), audio);
});

test('padMp3: past the ID3 limit bytes go to the end', async () => {
  const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(ID3_MAX)]);
  const out = await bytesOf(await padMp3(new Blob([tag]), 50, 'zero'));
  assert.equal(out.length, 60);
  assert.deepEqual(out.subarray(0, 10), tag);
});

test('findPdfStartxref: takes the last one', async () => {
  const pdf = new Blob(['%PDF-1.4\n...startxref\n11\n%%EOF\n...startxref\n222\n%%EOF\n']);
  assert.equal(await findPdfStartxref(pdf), '222');
  assert.equal(await findPdfStartxref(new Blob(['no xref'])), null);
});

test('padTo: hits the target exactly, never shrinks', async () => {
  const pdf = new Blob(['%PDF-1.4\nxref\nstartxref\n9\n%%EOF\n']);
  const grown = await padTo(pdf, 4096, 'pdf', 'random');
  assert.equal(grown.size, 4096);
  assert.ok((await grown.text()).endsWith('\nstartxref\n9\n%%EOF\n'));

  for (const ext of ['mp3', 'mp4', 'txt', 'bin']) {
    const out = await padTo(new Blob([new Uint8Array(30)]), 12345, ext, 'random');
    assert.equal(out.size, 12345, ext);
  }
  const small = new Blob(['abc']);
  assert.equal(await padTo(small, 3, 'txt'), small);
  assert.equal(await padTo(small, 1, 'txt'), small);
});
