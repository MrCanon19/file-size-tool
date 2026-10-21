// Copies the site into dist/ without development files, for `netlify deploy --dir=dist`.
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const SKIP = new Set(['dist', 'tests', 'scripts', 'package.json', 'node_modules']);
// Dotfiles (.git, .github, .nojekyll) never go out, at any depth; Netlify CLI skips them too.
const hidden = (path) => basename(path).startsWith('.');

rmSync('dist', { recursive: true, force: true });
// Entry by entry: copying '.' into its own dist/ subfolder is refused on Node 20.
for (const name of readdirSync('.')) {
  if (SKIP.has(name) || hidden(name)) continue;
  cpSync(name, join('dist', name), { recursive: true, filter: (src) => !hidden(src) });
}
