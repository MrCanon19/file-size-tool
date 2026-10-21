import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
