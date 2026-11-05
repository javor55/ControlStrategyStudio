// List of what a hierarchy folder contains (subfolders, continuous and sequence
// strategies), used by the folder view and the folder inspector.
import type { FolderNode, ProjectModel } from '@csd/core';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { DiagBadges } from '../ui/parts';
import { plural } from '../ui/text';
import { Icon } from '../project/icons';

export function findFolder(root: FolderNode, path: string): FolderNode | undefined {
  if (root.path === path) return root;
  for (const f of root.folders) {
    const hit = findFolder(f, path);
    if (hit) return hit;
  }
  return undefined;
}

/** All strategy and sequence files below a folder (recursively). */
export function filesBelow(node: FolderNode): string[] {
  return [...node.strategies, ...node.sequences, ...node.folders.flatMap(filesBelow)];
}

export function folderSummary(node: FolderNode): string {
  const all = filesBelow(node);
  const seq = all.filter((f) => f.endsWith('.seq.yaml')).length;
  const parts = [];
  if (node.folders.length) parts.push(plural(node.folders.length, 'subfolder'));
  parts.push(plural(all.length - seq, 'continuous strategy', 'continuous strategies'));
  if (seq) parts.push(plural(seq, 'sequence strategy', 'sequence strategies'));
  return parts.join(' · ');
}

function folderDiags(model: ProjectModel, node: FolderNode) {
  return filesBelow(node).flatMap((f) => diagsOf(model, f));
}

/** Icon of a strategy or sequence file (shared by tree, views, export dialog). */
export function StrategyIcon({ file }: { file: string }) {
  const seq = file.endsWith('.seq.yaml');
  return (
    <span className={`kind-ico ${seq ? 'sfc' : 'fbd'}`} title={seq ? 'Sequence strategy (SFC)' : 'Continuous strategy (FBD)'}>
      {seq ? Icon.sequence : Icon.strategy}
    </span>
  );
}

export function FolderContents({ node, compact }: { node: FolderNode; compact?: boolean }) {
  const model = useEditor((s) => s.model);
  const items = [...node.strategies, ...node.sequences];
  if (!node.folders.length && !items.length) return null;
  return (
    <ul className={`folder-list${compact ? ' compact' : ''}`} aria-label={`Contents of ${node.name}`}>
      {node.folders.map((f) => (
        <li key={f.path}>
          <button type="button" className="folder-item" onClick={() => (f.readme ? store().open(f.readme) : undefined)} disabled={!f.readme} title={f.path}>
            <span className="kind-ico">{Icon.folder}</span>
            <span className="folder-item-name">{f.name}</span>
            {f.level && <span className="level-badge">{f.level}</span>}
            <span className="folder-item-sub">{folderSummary(f)}</span>
            <DiagBadges diags={folderDiags(model, f)} />
          </button>
        </li>
      ))}
      {items.map((file) => {
        const s = model.strategyByFile.get(file) ?? model.sequenceByFile.get(file);
        return (
          <li key={file}>
            <button type="button" className="folder-item" onClick={() => store().open(file)} title={file}>
              <StrategyIcon file={file} />
              <span className="folder-item-name mono">{s?.name ?? file}</span>
              <span className="folder-item-sub">{s?.title}</span>
              <DiagBadges diags={diagsOf(model, file)} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
