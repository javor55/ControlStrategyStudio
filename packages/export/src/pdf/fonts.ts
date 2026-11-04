/// <reference path="./assets.d.ts" />
// Embedded Unicode fonts (CS Sans / CS Mono, subsets of IBM Plex) for jsPDF.
import type { jsPDF } from 'jspdf';
import sansRegular from '../../fonts/CSSans-Regular.ttf?inline';
import sansBold from '../../fonts/CSSans-Bold.ttf?inline';
import sansItalic from '../../fonts/CSSans-Italic.ttf?inline';
import monoRegular from '../../fonts/CSSMono-Regular.ttf?inline';
import monoBold from '../../fonts/CSSMono-Bold.ttf?inline';

export const SANS = 'CSSans';
export const MONO = 'CSSMono';
export type Family = typeof SANS | typeof MONO;

const cache = new Map<string, Promise<string>>();

/**
 * Base64 content of a font import. Builds inline it as a data: URL; the Vite
 * dev server may hand out a plain URL instead, which is fetched once.
 */
function base64(src: string): Promise<string> {
  if (src.startsWith('data:')) return Promise.resolve(src.slice(src.indexOf(',') + 1));
  let p = cache.get(src);
  if (!p) {
    p = fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`Font ${src}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      });
    p.catch(() => cache.delete(src));
    cache.set(src, p);
  }
  return p;
}

/** Font files and the jsPDF styles each one serves (missing styles are aliased). */
const FONTS: [file: string, data: string, family: Family, styles: string[]][] = [
  ['CSSans-Regular.ttf', sansRegular, SANS, ['normal']],
  ['CSSans-Bold.ttf', sansBold, SANS, ['bold', 'bolditalic']],
  ['CSSans-Italic.ttf', sansItalic, SANS, ['italic']],
  ['CSSMono-Regular.ttf', monoRegular, MONO, ['normal', 'italic']],
  ['CSSMono-Bold.ttf', monoBold, MONO, ['bold', 'bolditalic']],
];

/**
 * Registers the fonts in a document and returns, per family, a test whether a
 * code point has a glyph (characters without one are replaced before printing).
 */
export async function registerFonts(doc: jsPDF): Promise<Record<Family, (cp: number) => boolean>> {
  const data = await Promise.all(FONTS.map((f) => base64(f[1])));
  for (const [i, [file, , family, styles]] of FONTS.entries()) {
    doc.addFileToVFS(file, data[i]);
    for (const style of styles) doc.addFont(file, family, style);
  }
  const coverage = (family: Family): ((cp: number) => boolean) => {
    doc.setFont(family, 'normal');
    const map = (doc.getFont() as unknown as { metadata?: { cmap?: { unicode?: { codeMap?: Record<number, number> } } } }).metadata?.cmap?.unicode?.codeMap;
    if (!map) return (cp) => cp < 0x250; // Latin + Latin Extended, conservative
    return (cp) => !!map[cp];
  };
  return { [SANS]: coverage(SANS), [MONO]: coverage(MONO) } as Record<Family, (cp: number) => boolean>;
}
