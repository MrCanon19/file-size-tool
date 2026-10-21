// Copies the site into dist/ without development files, for `netlify deploy --dir=dist`.
import { cpSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const SKIP = new Set(['dist', 'tests', 'scripts', 'package.json', 'node_modules']);

rmSync('dist', { recursive: true, force: true });
cpSync('.', 'dist', {
  recursive: true,
  // Dotfiles (.git, .github, .nojekyll) never go out; Netlify CLI skips them too.
  filter: (src) => src === '.' || !(SKIP.has(src) || basename(src).startsWith('.')),
});
