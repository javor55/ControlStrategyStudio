// Inspector panels for files that are not drawn on a canvas: the project
// (project.yaml, README.md, nothing open), a hierarchy folder (its README.md),
// a function description, a library, a block type edited in the centre, an
// asset and any other file. Same scaffold as the element panels.
import { useEffect, useState } from 'react';
import { basename, classify, PROJECT_FILE, type BlockTypeDef, type FolderNode, type LibraryDef } from '@csd/core';
import { store, useEditor } from '../state/store';
import { activeView, diagsOf } from '../state/selectors';
import { Field, Row, SectionHeader, useMenu, type MenuEntry } from '../ui/kit';
import { AddButton, EmptyState } from '../ui/parts';
import { plural } from '../ui/text';
import { Icon } from '../project/icons';
import {
  copyAssetReference,
  deleteAsset,
  deleteFolder,
  deleteTypeVersion,
  editFolderDescription,
  newBlockType,
  newFolder,
  newSequence,
  newStrategy,
  newTypeVersion,
  renameAsset,
  renameFolder,
  renameFolderTo,
} from '../project/actions';
import { setProjectField } from '../settings/projectFields';
import { openSettings } from '../settings/open';
import { findFolder, FolderContents, folderSummary } from '../views/FolderContents';
import { DiagList, DocRow, Head, NAME_FIELD_ID, PathRow } from './Scaffold';
import { keys } from '../ui/keys';

/** Menu entries to create either kind of strategy in `folder`. */
export function newStrategyItems(folder: string): MenuEntry[] {
  return [
    { label: 'New continuous strategy…', hint: 'FBD', description: 'Function blocks and links', onClick: () => newStrategy(folder) },
    { label: 'New sequence strategy…', hint: 'SFC', description: 'Steps, transitions and actions', onClick: () => newSequence(folder) },
  ];
}

/** Menu entries to create a block type in library `lib`. */
export function newBlockTypeItems(lib: string): MenuEntry[] {
  return [
    { label: 'New basic block type…', description: 'Ports, parameters and reference code', onClick: () => newBlockType(lib, 'basic') },
    { label: 'New composite block type…', description: 'Drawn from other blocks', onClick: () => newBlockType(lib, 'composite') },
  ];
}

export function FilePanel() {
  const view = useEditor(activeView);
  const model = useEditor((s) => s.model);
  switch (view.kind) {
    case 'none':
    case 'project':
      return <ProjectPanel />;
    case 'doc': {
      const role = classify(view.file);
      if (role.kind === 'readme') {
        if (role.folder === null) return <ProjectPanel />;
        const node = findFolder(model.root, role.folder);
        if (node) return <FolderPanel key={node.path} node={node} />;
      }
      if (role.kind === 'strategy-doc') return <FunctionDocPanel file={view.file} />;
      return <OtherFilePanel file={view.file} kind="Document" />;
    }
    case 'library': {
      const lib = model.libraries.find((l) => l.folder === view.lib);
      return lib ? <LibraryPanel lib={lib} /> : <OtherFilePanel file={view.file} kind="Library" />;
    }
    case 'blocktype':
      return view.type ? <BlockTypeInfoPanel def={view.type} /> : <OtherFilePanel file={view.file} kind="Block type" />;
    case 'asset':
      return <AssetPanel file={view.file} />;
    default:
      return <OtherFilePanel file={view.file} kind="File" />;
  }
}

// --- project ------------------------------------------------------------------------------

function ProjectPanel() {
  const model = useEditor((s) => s.model);
  const hasReadme = useEditor((s) => typeof s.files['README.md'] === 'string');
  const meta = model.meta;
  const diags = diagsOf(model, PROJECT_FILE);
  return (
    <div className="insp-scroll" data-testid="project-panel">
      <Head
        kind="Project"
        title={meta.name}
        diags={diags}
        onRename
        menu={[
          { label: 'Settings…', hint: keys('Mod+,'), onClick: () => openSettings('project') },
          { label: 'Open project.yaml', onClick: () => store().open(PROJECT_FILE) },
        ]}
      />
      <DiagList diags={diags} />
      <Row label="Name">
        <Field id={NAME_FIELD_ID} value={meta.name} onCommit={(v) => (v.trim() ? setProjectField(['name'], v, 'Rename project') : store().toast('The project needs a name', 'error'))} />
      </Row>
      <Row label="Description">
        <Field multiline value={meta.description} placeholder="What the project is about" onCommit={(v) => setProjectField(['description'], v, 'Project description')} />
      </Row>
      <Row label="Author">
        <Field value={meta.author} placeholder="Company or person" onCommit={(v) => setProjectField(['author'], v, 'Project author')} />
      </Row>
      <Row label="Levels" title="Names of the folder depths">
        <span className="insp-inline">
          <span className={meta.levels.length ? '' : 'insp-muted'}>{meta.levels.length ? meta.levels.join(' › ') : 'None (plain folders)'}</span>
          <button type="button" className="btn small ghost" onClick={() => openSettings('project')}>
            Edit…
          </button>
        </span>
      </Row>
      <SectionHeader>Info</SectionHeader>
      <Row label="Content">
        <span className="insp-muted">
          {[
            plural(model.strategies.length, 'continuous strategy', 'continuous strategies'),
            plural(model.sequences.length, 'sequence strategy', 'sequence strategies'),
            plural(model.libraries.length, 'library'),
            plural(model.types.latest().length, 'block type'),
          ].join(' · ')}
        </span>
      </Row>
      <PathRow file={PROJECT_FILE} />
      <DocRow label="Project introduction" exists={hasReadme} onOpen={() => editFolderDescription(model.root)} />
    </div>
  );
}

// --- folder -------------------------------------------------------------------------------

function FolderPanel({ node }: { node: FolderNode }) {
  const model = useEditor((s) => s.model);
  const files = useEditor((s) => s.files);
  const levels = model.meta.levels;
  const diags = node.readme ? diagsOf(model, node.readme) : [];
  const menu = useMenu();
  const contents = [...node.strategies, ...node.sequences, ...node.folders.flatMap(function all(f: FolderNode): string[] {
    return [...f.strategies, ...f.sequences, ...f.folders.flatMap(all)];
  })];
  const allDiags = contents.flatMap((f) => diagsOf(model, f));
  return (
    <div className="insp-scroll" data-testid="folder-panel">
      <Head
        kind="Folder"
        title={node.name}
        sub={node.level && <span className="level-badge">{node.level}</span>}
        diags={allDiags}
        onRename={() => void renameFolder(node)}
        menu={[
          { label: 'New continuous strategy…', hint: 'FBD', onClick: () => newStrategy(node.path) },
          { label: 'New sequence strategy…', hint: 'SFC', onClick: () => newSequence(node.path) },
          { label: 'New subfolder…', hint: levels[node.depth] ?? undefined, onClick: () => void newFolder(node, levels[node.depth]) },
        ]}
        onDelete={() => void deleteFolder(node)}
        deleteLabel="Delete folder…"
      />
      <DiagList diags={diags} />
      <Row label="Name">
        <Field id={NAME_FIELD_ID} value={node.name} onCommit={(v) => v.trim() && v.trim() !== node.name && renameFolderTo(node, v.trim())} />
      </Row>
      <Row label="Level" title="Hierarchy level name of this folder depth (Settings → Project)">
        <span className={node.level ? '' : 'insp-muted'}>{node.level ?? 'None'}</span>
      </Row>
      <SectionHeader
        actions={
          <AddButton
            label="Add strategy"
            onClick={(el) => menu.openBelow(el, newStrategyItems(node.path))}
          />
        }
      >
        Contents
      </SectionHeader>
      {node.folders.length + node.strategies.length + node.sequences.length ? (
        <FolderContents node={node} compact />
      ) : (
        <EmptyState
          action={
            <button type="button" className="btn small" onClick={() => newStrategy(node.path)}>
              Add strategy…
            </button>
          }
        >
          This folder is empty.
        </EmptyState>
      )}
      <SectionHeader>Info</SectionHeader>
      <Row label="Content">
        <span className="insp-muted">{folderSummary(node)}</span>
      </Row>
      <PathRow file={`strategies/${node.path}/`} label="Path" />
      <DocRow label="Folder description" exists={!!node.readme && node.readme in files} onOpen={() => editFolderDescription(node)} />
      {menu.element}
    </div>
  );
}

// --- function description -------------------------------------------------------------------

function FunctionDocPanel({ file }: { file: string }) {
  const model = useEditor((s) => s.model);
  const yaml = file.replace(/\.md$/, '.yaml');
  const seqYaml = file.replace(/\.md$/, '.seq.yaml');
  const s = model.strategyByFile.get(yaml) ?? model.sequenceByFile.get(seqYaml) ?? model.sequenceByFile.get(yaml);
  const diags = diagsOf(model, file);
  return (
    <div className="insp-scroll" data-testid="doc-panel">
      <Head kind="Document" title="Function description" sub={s?.name} diags={diags} />
      <DiagList diags={diags} />
      <Row label={s && 'steps' in s ? 'Sequence' : 'Strategy'}>
        {s ? (
          <button type="button" className="insp-ep mono" onClick={() => store().open(s.file)} title={`Open ${s.name}`}>
            {s.name}
          </button>
        ) : (
          <span className="insp-muted">No strategy with this name</span>
        )}
      </Row>
      {s?.title && (
        <Row label="Title">
          <span>{s.title}</span>
        </Row>
      )}
      <div className="insp-msg">Printed in the PDF after the diagram. Use ```chart blocks for curves and images from assets/.</div>
      <SectionHeader>Info</SectionHeader>
      <PathRow file={file} />
      {s && <DocRow label="Diagram" exists onOpen={() => store().open(s.file)} what="diagram" />}
    </div>
  );
}

// --- library ---------------------------------------------------------------------------------

function LibraryPanel({ lib }: { lib: LibraryDef }) {
  const model = useEditor((s) => s.model);
  const diags = [...diagsOf(model, lib.file), ...lib.types.flatMap((t) => diagsOf(model, t.file))];
  const own = diagsOf(model, lib.file);
  const names = [...new Set(lib.types.map((t) => t.type))].sort((a, b) => a.localeCompare(b));
  const menu = useMenu();
  return (
    <div className="insp-scroll" data-testid="library-panel">
      <Head kind="Library" title={lib.folder} sub={<span className="pill">{lib.version}</span>} diags={diags} menu={newBlockTypeItems(lib.folder)} />
      <DiagList diags={own} />
      <Row label="Name">
        <span>{lib.name}</span>
      </Row>
      <Row label="Version">
        <span className="mono">{lib.version}</span>
      </Row>
      {lib.description && (
        <Row label="Description">
          <span className="insp-wrap">{lib.description}</span>
        </Row>
      )}
      <SectionHeader actions={<AddButton label="Add block type" onClick={(el) => menu.openBelow(el, newBlockTypeItems(lib.folder))} />}>
        Block types
      </SectionHeader>
      {names.length ? (
        <ul className="folder-list compact">
          {names.map((n) => {
            const v = model.types.versions(n, lib.folder)[0];
            return (
              <li key={n}>
                <button type="button" className="folder-item" onClick={() => store().open(v.file)} title={v.description}>
                  <span className="kind-ico">{v.kind === 'composite' ? Icon.composite : Icon.type}</span>
                  <span className="folder-item-name mono">{n}</span>
                  <span className="folder-item-sub">{v.category}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState>No block types yet.</EmptyState>
      )}
      <SectionHeader>Info</SectionHeader>
      <PathRow file={lib.file} />
      {menu.element}
    </div>
  );
}

// --- basic block type edited in the centre ----------------------------------------------------

function BlockTypeInfoPanel({ def }: { def: BlockTypeDef }) {
  const model = useEditor((s) => s.model);
  const diags = diagsOf(model, def.file);
  const versions = model.types.versions(def.type, def.library);
  return (
    <div className="insp-scroll" data-testid="type-info-panel">
      <Head
        kind={def.kind === 'composite' ? 'Composite' : 'Block type'}
        title={def.type}
        sub={<span className="pill">{`${def.library} · ${def.version}`}</span>}
        diags={diags}
        menu={[{ label: 'New version', hint: 'minor', onClick: () => newTypeVersion(def) }]}
        onDelete={() => void deleteTypeVersion(def)}
        deleteLabel="Delete version…"
      />
      <DiagList diags={diags} />
      <div className="insp-msg">The block type is edited in the centre. In the Text view (Alt+3) its editor moves here, next to the YAML.</div>
      <Row label="Category">
        <span>{def.category}</span>
      </Row>
      <Row label="Description">
        <span className="insp-wrap">{def.description || <span className="insp-muted">None</span>}</span>
      </Row>
      <SectionHeader>Info</SectionHeader>
      <Row label="Ports">
        <span className="insp-muted">{[plural(def.inputs.length, 'input'), plural(def.outputs.length, 'output'), plural(def.params.length, 'parameter')].join(' · ')}</span>
      </Row>
      <Row label="Versions">
        <span className="insp-muted">{versions.map((v) => v.version).join(', ')}</span>
      </Row>
      <PathRow file={def.file} />
    </div>
  );
}

// --- asset ------------------------------------------------------------------------------------

function AssetPanel({ file }: { file: string }) {
  const content = useEditor((s) => s.files[file]);
  const size = content === undefined ? 0 : typeof content === 'string' ? new Blob([content]).size : content.byteLength;
  const [dims, setDims] = useState<string>();
  const ext = file.split('.').pop()?.toUpperCase() ?? '';
  useEffect(() => {
    const img = document.querySelector<HTMLImageElement>('.asset-img');
    if (!img) return setDims(undefined);
    const upd = () => img.naturalWidth && setDims(`${img.naturalWidth} × ${img.naturalHeight} px`);
    upd();
    img.addEventListener('load', upd);
    return () => img.removeEventListener('load', upd);
  }, [file, content]);
  return (
    <div className="insp-scroll" data-testid="asset-panel">
      <Head kind="Asset" title={basename(file)} onRename={() => void renameAsset(file)} menu={[{ label: 'Copy Markdown reference', onClick: () => copyAssetReference(file) }]} onDelete={() => void deleteAsset(file)} deleteLabel="Delete…" />
      <Row label="Type">
        <span>{ext} image</span>
      </Row>
      <Row label="Size">
        <span>
          {(size / 1024).toFixed(1)} kB{dims ? ` · ${dims}` : ''}
        </span>
      </Row>
      <Row label="Markdown">
        <span className="insp-inline insp-nowrap">
          <code className="insp-code">{`![](${file})`}</code>
          <button type="button" className="btn small ghost icon" title="Copy Markdown reference" aria-label="Copy Markdown reference" onClick={() => copyAssetReference(file)}>
            {Icon.copy}
          </button>
        </span>
      </Row>
      <SectionHeader>Info</SectionHeader>
      <PathRow file={file} />
    </div>
  );
}

// --- anything else ------------------------------------------------------------------------------

function OtherFilePanel({ file, kind }: { file: string; kind: string }) {
  const model = useEditor((s) => s.model);
  const diags = diagsOf(model, file);
  return (
    <div className="insp-scroll" data-testid="file-panel">
      <Head kind={kind} title={basename(file)} diags={diags} />
      <DiagList diags={diags} />
      <div className="insp-msg">This file is edited as text: Split (Alt+2) or Text (Alt+3).</div>
      <SectionHeader>Info</SectionHeader>
      <PathRow file={file} />
    </div>
  );
}
