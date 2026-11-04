// Markdown documentation: marked + DOMPurify. Images come from the embedded
// project files; links to project files navigate inside the viewer; ```chart
// blocks become inline SVG charts, ```mermaid blocks a styled source box.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { classify, dirname, type Files } from '@csd/core';
import { renderChartSvg } from '@csd/export';
import { useData } from './context';
import { routeHash, type Route } from './route';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  pdf: 'application/pdf',
  txt: 'text/plain',
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

/** Resolves a Markdown reference to a project file (relative to the .md, or to the project root). */
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

function fileUrl(path: string, content: string | Uint8Array, created: string[]): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME[ext] ?? 'application/octet-stream';
  if (typeof content === 'string') return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: mime }));
  created.push(url);
  return url;
}

/** Viewer route for a project file, if it has a page. */
export function routeForFile(file: string, strategyFiles: Map<string, string>, typeKeyOfFile: Map<string, string>): Route | undefined {
  const role = classify(file);
  if (role.kind === 'project' || (role.kind === 'readme' && role.folder === null)) return { page: 'project' };
  if (role.kind === 'readme' && role.folder !== null) return role.folder ? { page: 'folder', path: role.folder } : { page: 'project' };
  if (role.kind === 'strategy' || role.kind === 'strategy-doc') {
    const name = strategyFiles.get(file.replace(/\.md$/, '.yaml'));
    if (name) return { page: 'strategy', name, tab: role.kind === 'strategy-doc' ? 'doc' : undefined, sel: null };
  }
  if (role.kind === 'sequence' || role.kind === 'strategy-doc') {
    const name = strategyFiles.get(file.replace(/\.md$/, '.seq.yaml'));
    if (name) return { page: 'sequence', name, tab: role.kind === 'strategy-doc' ? 'doc' : undefined, sel: null };
  }
  if (role.kind === 'blocktype') {
    const key = typeKeyOfFile.get(file);
    if (key) return { page: 'type', key, sel: null };
  }
  if (role.kind === 'library') return { page: 'library' };
  return undefined;
}

function renderMarkdown(text: string): string {
  const charts: string[] = [];
  const md = new Marked({
    gfm: true,
    renderer: {
      code({ text: src, lang }) {
        const l = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
        if (l === 'chart') {
          charts.push(src);
          return `<div class="md-chart" data-chart="${charts.length - 1}"></div>`;
        }
        if (l === 'mermaid')
          return `<div class="md-placeholder" data-kind="mermaid"><div class="md-placeholder-h">Mermaid diagram (source)</div><pre><code>${esc(src)}</code></pre></div>`;
        return false;
      },
    },
  });
  const html = DOMPurify.sanitize(md.parse(text, { async: false }) as string, { ADD_ATTR: ['data-kind', 'data-chart'] });
  // Charts are generated SVG (all text escaped by the chart renderer), inserted after sanitising.
  return html.replace(/<div class="md-chart" data-chart="(\d+)"><\/div>/g, (_m, i: string) => {
    const r = renderChartSvg(charts[Number(i)] ?? '');
    if ('error' in r) return `<div class="md-placeholder" data-kind="chart"><div class="md-placeholder-h error-text">Chart error: ${esc(r.error)}</div><pre><code>${esc(charts[Number(i)] ?? '')}</code></pre></div>`;
    return `<figure class="md-chart">${r.svg}</figure>`;
  });
}

export function Markdown({ file, text, className }: { file: string; text: string; className?: string }) {
  const d = useData();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const strategyFiles = useMemo(() => new Map(d.plan.items.map((s) => [s.file, s.name])), [d]);
  const typeKeyOfFile = useMemo(() => new Map([...d.typeByKey].map(([k, t]) => [t.def.file, k])), [d]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const created: string[] = [];
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
      if (!img.hasAttribute('data-src')) img.setAttribute('data-src', src);
      if (isExternal(src)) return; // remote images stay as written (they load only when online)
      const path = resolveProjectRef(src, file, d.files);
      const content = path ? d.files[path] : undefined;
      if (path && content !== undefined) {
        img.src = fileUrl(path, content, created);
        img.classList.remove('md-missing');
        img.title = img.title || path;
      } else {
        img.removeAttribute('src');
        img.classList.add('md-missing');
        img.alt = `Image not found: ${src}`;
      }
    });
    el.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      if (href.startsWith('#')) return;
      const path = resolveProjectRef(href, file, d.files);
      if (!path) return;
      const r = routeForFile(path, strategyFiles, typeKeyOfFile);
      a.classList.add('md-filelink');
      if (r) a.setAttribute('href', routeHash(r));
      else {
        const content = d.files[path];
        a.setAttribute('href', fileUrl(path, content, created));
        a.setAttribute('target', '_blank');
        a.setAttribute('download', path.split('/').pop() ?? 'file');
      }
    });
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, [html, d, file, strategyFiles, typeKeyOfFile]);

  return (
    <div
      ref={ref}
      className={`md${className ? ' ' + className : ''}`}
      onClick={(e) => {
        // In-document anchors must not replace the viewer route.
        const a = (e.target as HTMLElement).closest('a');
        const href = a?.getAttribute('href') ?? '';
        if (!href.startsWith('#') || /^#(s|q|f|t)=|^#(lib|project)\b/.test(href)) return;
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        (document.getElementById(id) ?? document.getElementsByName(id)[0])?.scrollIntoView({ block: 'start' });
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
