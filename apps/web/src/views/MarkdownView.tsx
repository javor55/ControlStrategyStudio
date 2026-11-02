// Markdown preview of a project file. Images that point to project files
// (`assets/x.png`, or relative to the Markdown file) are served from memory;
// links to project files open them in the editor.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { dirname, type Files } from '@csd/core';
import { store, useEditor } from '../state/store';
import './views.css';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (l !== 'chart' && l !== 'mermaid') return false;
      const label = l === 'chart' ? 'Chart' : 'Mermaid diagram';
      return `<div class="md-placeholder" data-kind="${l}"><div class="md-placeholder-h">${label} — rendered in PDF export (phase 3)</div><pre><code>${esc(text)}</code></pre></div>`;
    },
  },
});

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const isExternal = (href: string) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Resolves a Markdown reference to a project file path (or undefined). */
export function resolveProjectRef(ref: string, mdFile: string, files: Files): string | undefined {
  if (!ref || isExternal(ref)) return undefined;
  let p = ref.split(/[?#]/)[0];
  try {
    p = decodeURI(p);
  } catch {
    /* keep raw */
  }
  const candidates = p.startsWith('/') ? [normalize(p)] : [normalize(`${dirname(mdFile)}/${p}`), normalize(p)];
  return candidates.find((c) => c in files);
}

function toUrl(path: string, content: string | Uint8Array, created: string[]): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME[ext] ?? 'application/octet-stream';
  if (typeof content === 'string') return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: mime }));
  created.push(url);
  return url;
}

export function renderMarkdownHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-kind'] });
}

export function MarkdownView({ file, className }: { file: string; className?: string }) {
  const text = useEditor((s) => s.files[file]);
  const files = useEditor((s) => s.files);
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (typeof text === 'string' ? renderMarkdownHtml(text) : ''), [text]);

  // Resolve images after each render; object URLs are revoked on change/unmount.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const created: string[] = [];
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
      if (!img.hasAttribute('data-src')) img.setAttribute('data-src', src);
      if (isExternal(src)) {
        if (!img.src) img.src = src;
        return;
      }
      const path = resolveProjectRef(src, file, files);
      const content = path ? files[path] : undefined;
      if (path && content !== undefined) {
        img.src = toUrl(path, content, created);
        img.classList.remove('md-missing');
        img.title = img.title || path;
      } else {
        img.removeAttribute('src');
        img.classList.add('md-missing');
        img.alt = `Image not found: ${src}`;
        img.title = `Image not found in project: ${src}`;
      }
    });
    el.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else if (!href.startsWith('#') && resolveProjectRef(href, file, files)) a.classList.add('md-filelink');
    });
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, [html, files, file]);

  if (typeof text !== 'string') return <div className="empty">{file} is not a text file.</div>;

  return (
    <div
      ref={ref}
      className={`md${className ? ' ' + className : ''}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) return;
        const target = resolveProjectRef(href, file, store().getState().files);
        if (target) {
          e.preventDefault();
          store().open(target);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
