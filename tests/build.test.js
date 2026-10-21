import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = fileURLToPath(new URL('../scripts/build.js', import.meta.url));

const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)))
  .sort();

// Runs the build in a throwaway copy of the repo layout.
function build(tree) {
  const root = mkdtempSync(join(tmpdir(), 'build-test-'));
  for (const [path, body] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  execFileSync(process.execPath, [BUILD], { cwd: root });
  return root;
}

test('dist/ has the site and none of the development files', (t) => {
  const root = build({
    'index.html': '<!doctype html>',
    'app.js': 'app',
    '_headers': '/*',
    'README.md': '#',
    'vendor/ffmpeg/index.js': 'ff',
    'docs/screen.png': 'png',
    'tests/size.test.js': 'test',
    'scripts/build.js': 'build',
    'package.json': '{}',
    'node_modules/x/index.js': 'x',
    '.git/HEAD': 'ref',
    '.github/workflows/test.yml': 'ci',
    '.nojekyll': '',
    '.gitignore': 'dist/',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(files(join(root, 'dist')), [
    'README.md', '_headers', 'app.js', 'docs/screen.png', 'index.html', 'vendor/ffmpeg/index.js',
  ]);
  assert.equal(readFileSync(join(root, 'dist/app.js'), 'utf8'), 'app');
});

test('only top-level names are skipped, nested dotfiles never go out', (t) => {
  const root = build({
    'index.html': '',
    'vendor/tests/keep.js': 'keep',
    'vendor/package.json': '{}',
    'vendor/.DS_Store': 'mac',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(files(join(root, 'dist')), ['index.html', 'vendor/package.json', 'vendor/tests/keep.js']);
});

test('a stale dist/ is replaced, not nested', (t) => {
  const root = build({ 'index.html': 'new', 'dist/old.html': 'old', 'dist/index.html': 'old' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(files(join(root, 'dist')), ['index.html']);
  assert.equal(readFileSync(join(root, 'dist/index.html'), 'utf8'), 'new');
});

// Local files a page or script loads: HTML src/href, JS imports and `new URL('…', import.meta.url)`.
const REFS = {
  html: /\b(?:src|href)="([^"#?]+)/g,
  js: /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*)['"]([^'"]+)['"]/g,
};

function localRefs(file, text) {
  const kind = file.endsWith('.html') ? 'html' : 'js';
  // Doc comments in vendor code show example URLs that are never loaded.
  const code = kind === 'js' ? text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '') : text;
  return [...code.matchAll(REFS[kind])]
    .map((m) => m[1])
    .filter((ref) => !/^(?:[a-z]+:|\/\/)/i.test(ref));
}

test('the real build ships every local file the site loads', (t) => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'build-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(repo, root, { recursive: true, filter: (src) => !/[\\/](?:\.git|dist|node_modules)$/.test(src) });
  execFileSync(process.execPath, [BUILD], { cwd: root });
  const dist = join(root, 'dist');

  const seen = new Set();
  const queue = ['index.html', '404.html'];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(join(dist, file)), `${file} is missing from dist/`);
    if (!/\.(?:html|js)$/.test(file)) continue;
    for (const ref of localRefs(file, readFileSync(join(dist, file), 'utf8'))) {
      const target = ref.startsWith('/') ? ref.slice(1) : join(dirname(file), ref);
      queue.push(target === '' ? 'index.html' : target);
    }
  }
  // The crawl really followed the page into its modules and workers.
  for (const file of ['app.js', 'size.js', 'templates.js', 'pdf-worker.js', 'vendor/ffmpeg/worker.js', 'style.css']) {
    assert.ok(seen.has(file), `${file} was not reached`);
  }
});
