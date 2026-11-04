import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const viewerHtml = fileURLToPath(new URL('../viewer/dist/index.html', import.meta.url));
const stub = fileURLToPath(new URL('./src/export/stub.ts', import.meta.url));

/**
 * `virtual:viewer-template` = the built read-only viewer (apps/viewer/dist/index.html)
 * used as the template of interactive HTML exports. `npm run build` builds the
 * viewer first; in dev without a viewer build the export reports it is unavailable.
 */
function viewerTemplate(): Plugin {
  const id = 'virtual:viewer-template';
  return {
    name: 'viewer-template',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return undefined;
      if (existsSync(viewerHtml)) this.addWatchFile(viewerHtml);
      const html = existsSync(viewerHtml) ? readFileSync(viewerHtml, 'utf8') : '';
      return `export default ${JSON.stringify(html)};`;
    },
  };
}

// Builds ONE self-contained dist/index.html that runs offline (double-click, file://).
export default defineConfig({
  base: './',
  plugins: [react(), viewerTemplate(), viteSingleFile()],
  resolve: {
    // Optional jsPDF dependencies for HTML rendering we never use.
    alias: { html2canvas: stub, canvg: stub },
  },
  build: { chunkSizeWarningLimit: 8000 },
});
