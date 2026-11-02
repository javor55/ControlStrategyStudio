// Source editor (bottom of the right column): the YAML / Markdown text of the
// active file. Text and diagram are two views of the same file — see
// controller.ts for the sync rules.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseYaml, type Diag, type Selection } from '@csd/core';
import { useEditor } from '../state/store';
import { diagsOf, useActiveDiagram } from '../state/selectors';
import { SeverityBadge } from '../ui/kit';
import { modeOf, selKey, SourceController } from './controller';
import './editor.css';

const MODE_LABEL = { yaml: 'YAML', markdown: 'Markdown', text: 'Text' } as const;

export function SourceEditor() {
  const projectId = useEditor((s) => s.projectId);
  const file = useEditor((s) => s.activeFile);
  const content = useEditor((s) => (s.activeFile ? s.files[s.activeFile] : undefined));
  const model = useEditor((s) => s.model);
  const selection = useEditor((s) => s.selection);
  const d = useActiveDiagram();

  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<SourceController>();
  const [dirty, setDirty] = useState(false);
  const binary = content instanceof Uint8Array;
  const text = typeof content === 'string' ? content : undefined;
  const mode = modeOf(file);

  useLayoutEffect(() => {
    const c = new SourceController(host.current!);
    c.onDirty = setDirty;
    ctl.current = c;
    return () => {
      c.destroy();
      ctl.current = undefined;
    };
  }, []);

  // Which diagram the text belongs to (for selection sync).
  useLayoutEffect(() => {
    const c = ctl.current!;
    c.diagram = d
      ? {
          file: d.file,
          root: d.root,
          sheetOf: (s: Selection) =>
            s?.kind === 'block' ? d.diagram.blocks.find((b) => b.id === s.id)?.sheet : s?.kind === 'note' ? d.diagram.notes.find((n) => n.index === s.index)?.sheet : undefined,
        }
      : undefined;
  }, [d]);

  // Document: file switch and external changes.
  useLayoutEffect(() => {
    ctl.current!.show(projectId, binary ? null : file, text);
  }, [projectId, file, text, binary]);

  // Diagnostics → lint markers.
  const diags = useMemo<Diag[]>(() => {
    const list = diagsOf(model, file);
    if (mode === 'yaml' && text !== undefined && !list.some((x) => x.code === 'yaml-syntax')) {
      const err = parseYaml(text).error;
      if (err) return [...list, { severity: 'error', code: 'yaml-syntax', message: err.message, file: file ?? undefined, line: err.line }];
    }
    return list;
  }, [model, file, text, mode]);
  useEffect(() => {
    ctl.current!.setDiagnostics(diags);
  }, [diags, file]);

  // Selection: highlight, and scroll when it changed elsewhere (canvas, inspector).
  const lastSel = useRef<string>('');
  const lastFile = useRef<string | null>(null);
  useEffect(() => {
    const c = ctl.current!;
    const key = selKey(selection);
    const changed = key !== lastSel.current || file !== lastFile.current;
    lastSel.current = key;
    lastFile.current = file;
    const fromEditor = c.selfSelection === key;
    if (changed) c.selfSelection = null;
    c.highlight(selection, changed && !fromEditor);
  }, [selection, file, text, d]);

  const errors = diags.filter((x) => x.severity === 'error').length;
  return (
    <section className="src" aria-label="Source">
      <div className="src-head">
        <span className="src-path mono" title={file ?? ''}>
          {file ? `‎${file}‎` : 'No file'}
        </span>
        {dirty && <span className="src-dirty" title="Applying your typing…">●</span>}
        <SeverityBadge diags={diags} />
        <span className={`badge ${binary ? 'neutral' : errors ? 'error' : 'info'} src-mode`}>{binary ? 'Binary' : MODE_LABEL[mode]}</span>
      </div>
      <div className="src-body">
        <div ref={host} className="src-cm" hidden={binary || !file} />
        {binary && (
          <div className="empty">
            <b>{file?.split('/').pop()}</b> is a binary asset ({(content as Uint8Array).byteLength.toLocaleString()} bytes) and cannot be edited as text.
          </div>
        )}
        {!file && <div className="empty">Open a file in the project tree to see its source.</div>}
      </div>
    </section>
  );
}
