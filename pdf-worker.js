// Runs Ghostscript (pdfwrite) off the main thread. One fresh instance per pass,
// because an Emscripten program can't call main() twice.
const GS_URL = 'https://cdn.jsdelivr.net/npm/@okathira/ghostpdl-wasm@1.1.0/dist/gs.js';

let loadGs = null;
let wasmBinary = null;

self.onmessage = async ({ data }) => {
  const { id, args, ps, input } = data;
  try {
    loadGs ??= (await import(GS_URL)).default;
    wasmBinary ??= await (await fetch(GS_URL.replace(/gs\.js$/, 'gs.wasm'))).arrayBuffer();
    const log = [];
    let pages = 0;
    const print = (line) => {
      log.push(line);
      const total = line.match(/Processing pages \d+ through (\d+)/);
      if (total) {
        pages = Number(total[1]);
        self.postMessage({ id, type: 'pages', total: pages });
      }
      const page = line.match(/^Page (\d+)/);
      if (page) self.postMessage({ id, type: 'page', page: Number(page[1]) });
    };
    const gs = await loadGs({ wasmBinary, print, printErr: (line) => log.push(line) });
    gs.FS.writeFile('in.pdf', input);
    try {
      gs.callMain([...args, '-sOutputFile=out.pdf', ...(ps ? ['-c', ps, '-f'] : []), 'in.pdf']);
    } catch { /* exit() throws ExitStatus; the output file tells us if it worked */ }
    // On a file it can't open, gs still writes an empty one-page PDF, so only trust
    // the output when it actually announced and processed the pages.
    const text = log.join('\n');
    if (/password/i.test(text)) throw new Error('Ten PDF jest zabezpieczony hasłem. Zapisz kopię bez hasła i spróbuj ponownie.');
    let out = null;
    try { out = gs.FS.readFile('out.pdf'); } catch { /* no output */ }
    if (!pages || !out?.length) {
      throw new Error(`Ghostscript nie odczytał tego PDF-a. ${log.filter((l) => /error/i.test(l)).slice(0, 2).join(' ')}`.trim());
    }
    self.postMessage({ id, type: 'done', bytes: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
