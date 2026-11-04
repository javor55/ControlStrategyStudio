import { describe, expect, it } from 'vitest';
import { Lexer, type Tokens } from 'marked';
import { fitBox, inlineRuns, normalizePath, pagesFor, plainText, resolveAssetPath, sanitizeText, sniffImage, svgSize, wrapRuns, type Run } from '../src/pdf/util';

describe('pdf helpers', () => {
  it('resolves Markdown image paths relative to the file, then to the root', () => {
    const files = new Set(['assets/a.png', 'strategies/U100/img/b.svg']);
    const has = (p: string) => files.has(p);
    expect(normalizePath('a/./b/../c')).toBe('a/c');
    expect(normalizePath('../x')).toBeUndefined();
    expect(resolveAssetPath('img/b.svg', 'strategies/U100/P101.md', has)).toBe('strategies/U100/img/b.svg');
    expect(resolveAssetPath('../../assets/a.png', 'strategies/U100/P101.md', has)).toBe('assets/a.png');
    expect(resolveAssetPath('/assets/a.png', 'strategies/U100/P101.md', has)).toBe('assets/a.png');
    expect(resolveAssetPath('assets/a.png', 'strategies/U100/P101.md', has)).toBe('assets/a.png');
    expect(resolveAssetPath('https://x/a.png', 'README.md', has)).toBeUndefined();
  });
  it('sniffs image types and SVG sizes', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]))).toBe('png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('svg');
    expect(svgSize('<svg viewBox="0 0 200 100" width="50">')).toEqual({ w: 200, h: 100 });
    expect(svgSize('<svg width="30px" height="20">')).toEqual({ w: 30, h: 20 });
  });
  it('fits boxes without exceeding the maximum scale', () => {
    expect(fitBox(100, 50, 50, 50)).toMatchObject({ w: 50, h: 25 });
    expect(fitBox(10, 10, 100, 100, 1.6).w).toBeCloseTo(16);
    expect(pagesFor(10, 30, 40)).toBe(1);
    expect(pagesFor(75, 30, 40)).toBe(3);
  });
  it('replaces characters missing in the font', () => {
    const has = (cp: number) => cp < 0x250 || cp === 0x2212;
    expect(sanitizeText('z⁻¹ Řízení', has)).toBe('z−¹ Řízení');
    expect(sanitizeText('a ≥ b', has)).toBe('a >= b');
    expect(sanitizeText('∑', has)).toBe('?');
  });
  it('turns inline Markdown into styled runs', () => {
    const p = Lexer.lex('A **bold _both_** `code` [link](https://x) ![img](a.png)')[0] as Tokens.Paragraph;
    const runs = inlineRuns(p.tokens);
    expect(runs.some((r) => 'text' in r && r.text === 'both' && r.style === 'bolditalic')).toBe(true);
    expect(runs.some((r) => 'text' in r && r.text === 'code' && r.mono)).toBe(true);
    expect(runs.some((r) => 'text' in r && r.link === 'https://x')).toBe(true);
    expect(runs.some((r) => 'image' in r && r.image.href === 'a.png')).toBe(true);
    expect(plainText(p.tokens)).toContain('bold both');
  });
  it('wraps runs into lines', () => {
    const measure = (t: string) => t.length;
    const runs: Run[] = [{ text: 'aaa bbb  ccc', style: 'normal' }, { text: ' dddddddddddd', style: 'bold' }];
    const lines = wrapRuns(runs, 8, measure);
    expect(lines.map((l) => l.segments.map((s) => s.text).join(''))).toEqual(['aaa bbb', 'ccc', 'dddddddd', 'dddd']);
    expect(wrapRuns([{ text: 'a\nb', style: 'normal' }], 10, measure)).toHaveLength(2);
  });
});
