import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES } from '../templates.js';
import { padTo } from '../size.js';

const decode = (name) => new Uint8Array(Buffer.from(TEMPLATES[name], 'base64'));
const ascii = (u8, from, to) => Buffer.from(u8.subarray(from, to)).toString('latin1');

test('every template is valid base64', () => {
  for (const [name, data] of Object.entries(TEMPLATES)) {
    assert.match(data, /^[A-Za-z0-9+/]+={0,2}$/, name);
    assert.equal(data.length % 4, 0, name);
  }
});

test('templates start with the right signature', () => {
  const ftyp = (name, brand) => {
    const u8 = decode(name);
    assert.equal(ascii(u8, 4, 8), 'ftyp', name);
    assert.equal(ascii(u8, 8, 12), brand, name);
  };
  ftyp('heic', 'heic');
  ftyp('mp4', 'isom');
  ftyp('mov', 'qt  ');
  assert.equal(ascii(decode('mp3'), 0, 3), 'ID3');
  assert.match(ascii(decode('gif'), 0, 6), /^GIF8[79]a$/);
});

test('ISO-BMFF templates: top-level boxes add up to the file size', () => {
  for (const name of ['heic', 'mp4', 'mov']) {
    const u8 = decode(name);
    const dv = new DataView(u8.buffer);
    let at = 0;
    while (at < u8.length) {
      // Size 1 means a 64-bit size follows the box type.
      const size = dv.getUint32(at) === 1 ? Number(dv.getBigUint64(at + 8)) : dv.getUint32(at);
      assert.ok(size >= 8, `${name}: box at ${at}`);
      at += size;
    }
    assert.equal(at, u8.length, name);
  }
});

test('templates are tiny, so small target weights still work', () => {
  for (const name of Object.keys(TEMPLATES)) assert.ok(decode(name).length < 8192, name);
});

test('templates pad to an exact weight', async () => {
  for (const name of Object.keys(TEMPLATES)) {
    const target = 1024 * 1024 + 1;
    const out = await padTo(new Blob([decode(name)]), target, name, 'random');
    assert.equal(out.size, target, name);
  }
});
