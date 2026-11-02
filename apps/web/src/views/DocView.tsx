// Centre view for Markdown files: rendered preview, edited on the right.
import { classify } from '@csd/core';
import { store, useEditor } from '../state/store';
import { MarkdownView } from './MarkdownView';
import './views.css';

export { MarkdownView } from './MarkdownView';

export function DocView() {
  const file = useEditor((s) => s.activeFile);
  const model = useEditor((s) => s.model);
  if (!file) return null;
  const role = classify(file);
  let context: { label: string; open: () => void } | undefined;
  if (role.kind === 'strategy-doc') {
    const yaml = file.replace(/\.md$/, '.yaml');
    const s = model.strategyByFile.get(yaml);
    if (s) context = { label: `Open diagram ${s.name}`, open: () => store().open(yaml) };
  }
  const subtitle =
    role.kind === 'strategy-doc'
      ? `Function description of ${role.name}`
      : role.kind === 'readme'
        ? role.folder === null
          ? 'Project introduction'
          : `Description of ${role.folder.split('/').pop()}`
        : undefined;
  return (
    <div className="view">
      <div className="view-head">
        <span className="mono view-path">{file}</span>
        {subtitle && <span className="view-sub">{subtitle}</span>}
        <span className="spacer" />
        {context && (
          <button className="btn small" onClick={context.open}>
            {context.label}
          </button>
        )}
        <span className="view-note">Edit as text in Split (Alt+2) or Text (Alt+3) mode</span>
      </div>
      <div className="view-body scroll">
        <article className="doc-page">
          <MarkdownView file={file} />
        </article>
      </div>
    </div>
  );
}
