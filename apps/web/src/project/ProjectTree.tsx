// Project tree: project files, ISA-95 hierarchy of strategies, libraries, assets.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { basename, libraryFile, PROJECT_FILE, strategyDocFile, type BlockTypeDef, type FolderNode, type LibraryDef } from '@csd/core';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { DiagBadges } from '../ui/parts';
import { plural } from '../ui/text';
import { newBlockTypeItems, newStrategyItems } from '../inspector/FilePanels';
import { openSettings } from '../settings/open';
import { ChangeDot } from '../history/DiffDetails';
import { Icon } from './icons';
import {
  addAsset,
  copyAssetReference,
  deleteAsset,
  deleteFolder,
  deleteStrategy,
  deleteTypeVersion,
  duplicateStrategy,
  editFolderDescription,
  importLibraryZip,
  moveStrategy,
  newFolder,
  newLibrary,
  newSequence,
  newStrategy,
  newTypeVersion,
  openFunctionDescription,
  renameAsset,
  renameBlockTypeDialog,
  renameFolder,
  renameProject,
  renameStrategy,
} from './actions';
import './project.css';
import { keys } from '../ui/keys';

type MenuOpener = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => void;

interface TreeRowProps {
  depth: number;
  icon?: ReactNode;
  /** undefined = not expandable */
  expanded?: boolean;
  onToggle?: () => void;
  label: ReactNode;
  title?: string;
  active?: boolean;
  onActivate?: () => void;
  menu?: () => MenuEntry[];
  openMenu: MenuOpener;
  actions?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  testId?: string;
  /** F2 / double-click on the label. */
  onRename?: () => void;
}

function TreeRow(p: TreeRowProps) {
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      p.onActivate?.();
    } else if (e.key === 'ArrowRight' && p.expanded === false) p.onToggle?.();
    else if (e.key === 'ArrowLeft' && p.expanded === true) p.onToggle?.();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...document.querySelectorAll<HTMLElement>('.tree .tree-row')];
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      rows[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'F2' && p.onRename) {
      e.preventDefault();
      p.onRename();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (p.menu) p.openMenu({ clientX: r.left + 24, clientY: r.bottom }, p.menu());
    }
  };
  return (
    <div
      className={`tree-row${p.active ? ' active' : ''}${p.className ? ' ' + p.className : ''}`}
      style={{ paddingLeft: 4 + p.depth * 14 }}
      role="treeitem"
      aria-expanded={p.expanded}
      aria-selected={p.active}
      tabIndex={0}
      title={p.title}
      data-testid={p.testId}
      onClick={() => p.onActivate?.()}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        if (!p.menu) return;
        e.preventDefault();
        e.stopPropagation();
        p.openMenu(e, p.menu());
      }}
    >
      <span
        className="twisty"
        onClick={(e) => {
          if (p.expanded === undefined) return;
          e.stopPropagation();
          p.onToggle?.();
        }}
      >
        {p.expanded !== undefined && Icon.chevron(p.expanded)}
      </span>
      {p.icon && <span className="tree-ico">{p.icon}</span>}
      <span
        className="tree-label"
        onDoubleClick={
          p.onRename
            ? (e) => {
                e.stopPropagation();
                p.onRename!();
              }
            : undefined
        }
      >
        {p.label}
      </span>
      {p.trailing}
      <span className="acts" onClick={(e) => e.stopPropagation()}>
        {p.actions}
        {p.menu && (
          <button
            className="btn ghost small icon"
            title="More actions"
            aria-label="More actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              p.openMenu({ clientX: r.left, clientY: r.bottom + 2 }, p.menu!());
            }}
          >
            {Icon.more}
          </button>
        )}
      </span>
    </div>
  );
}

function ActBtn(props: { title: string; onClick: (el: HTMLElement) => void; children: ReactNode }) {
  return (
    <button
      className="btn ghost small icon"
      title={props.title}
      aria-label={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick(e.currentTarget);
      }}
    >
      {props.children}
    </button>
  );
}

function Section(props: { id: string; title: string; open: boolean; onToggle: () => void; actions?: ReactNode; children: ReactNode; count?: number; countTitle?: string }) {
  return (
    <div className="tree-sec" role="group" aria-label={props.title}>
      <div className="section-h tree-sec-h" onClick={props.onToggle}>
        <span className="twisty">{Icon.chevron(props.open)}</span>
        <span>{props.title}</span>
        {props.count !== undefined && (
          <span className="tree-count" title={props.countTitle}>
            {props.count}
          </span>
        )}
        <span className="spacer" />
        <span className="sec-acts" onClick={(e) => e.stopPropagation()}>
          {props.actions}
        </span>
      </div>
      {props.open && props.children}
    </div>
  );
}

export function ProjectTree() {
  const model = useEditor((s) => s.model);
  const active = useEditor((s) => s.activeFile);
  const files = useEditor((s) => s.files);
  const menu = useMenu();
  // Folders default open, libraries and types default closed; this map overrides.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, def: boolean) => toggled[key] ?? def;
  const setOpen = (key: string, v: boolean) => setToggled((t) => ({ ...t, [key]: v }));
  const toggle = (key: string, def: boolean) => setOpen(key, !isOpen(key, def));
  const zipInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Keep the active file visible.
  useEffect(() => {
    const el = treeRef.current?.querySelector('.tree-row.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const levels = model.meta.levels;
  const open = (file: string) => store().open(file);

  // --- hierarchy ---------------------------------------------------------------------
  const doRenameFolder = async (node: FolderNode) => {
    const to = await renameFolder(node);
    if (to === undefined) return;
    // Carry the open / closed state of the folder and its subfolders over to the new path.
    setToggled((t) => {
      const next = { ...t };
      const from = `f:${node.path}`;
      for (const [k, v] of Object.entries(t)) {
        if (k === from || k.startsWith(from + '/')) {
          delete next[k];
          next[`f:${to}${k.slice(from.length)}`] = v;
        }
      }
      next[`f:${to}`] = true;
      return next;
    });
    // Focus the renamed folder row again (keyboard users keep their place).
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-testid="folder-${CSS.escape(to)}"]`)?.focus());
  };

  const folderMenu = (node: FolderNode): MenuEntry[] => [
    { section: node.level ? `${node.level} · ${node.name}` : node.name },
    { label: 'New continuous strategy…', hint: 'FBD', onClick: () => newStrategy(node.path) },
    { label: 'New sequence strategy…', hint: 'SFC', onClick: () => newSequence(node.path) },
    {
      label: 'New subfolder…',
      hint: levels[node.depth] ?? undefined,
      onClick: async () => {
        await newFolder(node, levels[node.depth]);
        setOpen(`f:${node.path}`, true);
      },
    },
    { label: node.readme && node.readme in files ? 'Folder description' : 'Add folder description', onClick: () => editFolderDescription(node) },
    'separator',
    { label: 'Rename…', hint: 'F2', onClick: () => doRenameFolder(node) },
    'separator',
    { label: 'Delete…', danger: true, onClick: () => deleteFolder(node) },
  ];

  const strategyMenu = (file: string): MenuEntry[] => {
    const s = model.strategyByFile.get(file) ?? model.sequenceByFile.get(file);
    const hasDoc = strategyDocFile(file) in files;
    return [
      { section: `${s?.name ?? basename(file)} · ${model.sequenceByFile.has(file) ? 'SFC' : 'FBD'}` },
      { label: 'Open', onClick: () => open(file) },
      { label: hasDoc ? 'Function description' : 'Add function description', onClick: () => openFunctionDescription(file) },
      'separator',
      { label: 'Rename…', hint: 'F2', onClick: () => renameStrategy(file) },
      { label: 'Duplicate…', onClick: () => duplicateStrategy(file) },
      { label: 'Move to folder…', onClick: () => moveStrategy(file) },
      'separator',
      { label: 'Delete…', danger: true, onClick: () => deleteStrategy(file) },
    ];
  };

  const renderStrategy = (file: string, depth: number) => {
    const s = model.strategyByFile.get(file);
    const md = strategyDocFile(file);
    const hasDoc = md in files;
    const diags = diagsOf(model, file);
    return (
      <TreeRow
        key={file}
        depth={depth}
        icon={Icon.strategy}
        label={s?.name ?? basename(file)}
        title={[`Continuous strategy (FBD)${s?.title ? ': ' + s.title : ''}`, s?.description, file].filter(Boolean).join('\n')}
        active={active === file || active === md}
        className="strategy"
        testId={`strategy-${s?.name}`}
        onActivate={() => open(file)}
        menu={() => strategyMenu(file)}
        openMenu={menu.open}
        onRename={() => renameStrategy(file)}
        trailing={
          <>
            {s?.title && <span className="tree-sub">{s.title}</span>}
            <ChangeDot file={file} />
            <DiagBadges diags={diags} />
          </>
        }
        actions={
          <ActBtn title={hasDoc ? 'Function description' : 'Add function description'} onClick={() => openFunctionDescription(file)}>
            {Icon.doc}
          </ActBtn>
        }
      />
    );
  };

  const renderSequence = (file: string, depth: number) => {
    const s = model.sequenceByFile.get(file);
    const md = strategyDocFile(file);
    const hasDoc = md in files;
    const diags = diagsOf(model, file);
    return (
      <TreeRow
        key={file}
        depth={depth}
        icon={Icon.sequence}
        label={s?.name ?? basename(file)}
        title={[`Sequence strategy (SFC)${s?.title ? ': ' + s.title : ''}`, s?.description, file].filter(Boolean).join('\n')}
        active={active === file || active === md}
        className="strategy sequence"
        testId={`sequence-${s?.name}`}
        onActivate={() => open(file)}
        menu={() => strategyMenu(file)}
        openMenu={menu.open}
        onRename={() => renameStrategy(file)}
        trailing={
          <>
            {s?.title && <span className="tree-sub">{s.title}</span>}
            <ChangeDot file={file} />
            <DiagBadges diags={diags} />
          </>
        }
        actions={
          <ActBtn title={hasDoc ? 'Function description' : 'Add function description'} onClick={() => openFunctionDescription(file)}>
            {Icon.doc}
          </ActBtn>
        }
      />
    );
  };

  const folderDiags = (node: FolderNode) => {
    const out: ReturnType<typeof diagsOf>[number][] = [];
    const walk = (n: FolderNode) => {
      for (const f of [...n.strategies, ...n.sequences]) out.push(...diagsOf(model, f));
      n.folders.forEach(walk);
    };
    walk(node);
    return out;
  };

  const renderFolder = (node: FolderNode, depth: number): ReactNode => {
    const key = `f:${node.path}`;
    const expanded = isOpen(key, true);
    const collapsedDiags = expanded ? [] : folderDiags(node);
    return (
      <div key={node.path} role="group">
        <TreeRow
          depth={depth}
          icon={Icon.folder}
          expanded={expanded}
          onToggle={() => toggle(key, true)}
          label={node.name}
          title={`${node.level ? node.level + ': ' : ''}${node.path}${node.readme ? '' : '\n(no description yet)'}`}
          active={!!node.readme && active === node.readme}
          className="folder"
          testId={`folder-${node.path}`}
          onActivate={() => {
            if (node.readme && active !== node.readme) {
              open(node.readme);
              setOpen(key, true);
            } else toggle(key, true);
          }}
          menu={() => folderMenu(node)}
          onRename={() => doRenameFolder(node)}
          openMenu={menu.open}
          trailing={
            <>
              {node.level && (
                <span className="level-badge" title={`Hierarchy level: ${node.level}`}>
                  {node.level}
                </span>
              )}
              {!expanded && <DiagBadges diags={collapsedDiags} title={`In this folder: ${plural(collapsedDiags.filter((d) => d.severity === 'error').length, 'error')}, ${plural(collapsedDiags.filter((d) => d.severity === 'warning').length, 'warning')}`} />}
            </>
          }
          actions={
            <ActBtn title="New strategy here (continuous or sequence)" onClick={(el) => menu.openBelow(el, newStrategyItems(node.path))}>
              {Icon.plus}
            </ActBtn>
          }
        />
        {expanded && (
          <>
            {node.folders.map((f) => renderFolder(f, depth + 1))}
            {node.strategies.map((f) => renderStrategy(f, depth + 1))}
            {node.sequences.map((f) => renderSequence(f, depth + 1))}
          </>
        )}
      </div>
    );
  };

  // --- libraries -----------------------------------------------------------------------
  const typeMenu = (def: BlockTypeDef): MenuEntry[] => [
    { section: `${def.library}/${def.type}@${def.version}` },
    { label: 'Open', onClick: () => open(def.file) },
    { label: 'New version', hint: 'minor', onClick: () => newTypeVersion(def) },
    'separator',
    { label: 'Rename…', hint: 'F2', onClick: () => renameBlockTypeDialog(def) },
    'separator',
    { label: 'Delete version…', danger: true, onClick: () => deleteTypeVersion(def) },
  ];

  const libMenu = (lib: LibraryDef): MenuEntry[] => [
    { section: lib.name },
    { label: 'Open', onClick: () => open(lib.file) },
    'separator',
    ...newBlockTypeItems(lib.folder).map((m) => (typeof m === 'object' && 'label' in m ? { ...m, description: undefined } : m)),
  ];

  const renderLibrary = (lib: LibraryDef) => {
    const key = `l:${lib.folder}`;
    const expanded = isOpen(key, false);
    const names = [...new Set(lib.types.map((t) => t.type))].sort((a, b) => a.localeCompare(b));
    const libDiags = [...diagsOf(model, lib.file), ...lib.types.flatMap((t) => diagsOf(model, t.file))];
    return (
      <div key={lib.folder} role="group">
        <TreeRow
          depth={0}
          icon={Icon.library}
          expanded={expanded}
          onToggle={() => toggle(key, false)}
          label={lib.folder}
          title={`${lib.name} ${lib.version}${lib.description ? '\n' + lib.description : ''}`}
          active={active === lib.file || active === libraryFile(lib.folder)}
          testId={`lib-${lib.folder}`}
          onActivate={() => {
            open(lib.file in files ? lib.file : libraryFile(lib.folder));
            setOpen(key, true);
          }}
          menu={() => libMenu(lib)}
          openMenu={menu.open}
          onRename={() => store().toast(`Libraries are renamed by their folder; rename library/${lib.folder}/ outside the editor`)}
          trailing={
            <>
              <span className="tree-sub">{plural(names.length, 'type')}</span>
              <DiagBadges diags={libDiags} />
            </>
          }
          actions={
            <ActBtn title="New block type (basic or composite)" onClick={(el) => menu.openBelow(el, newBlockTypeItems(lib.folder))}>
              {Icon.plus}
            </ActBtn>
          }
        />
        {expanded &&
          names.map((name) => {
            const versions = model.types.versions(name, lib.folder);
            const newest = versions[0];
            const tkey = `t:${lib.folder}/${name}`;
            const texp = versions.length > 1 ? isOpen(tkey, false) : undefined;
            const composite = newest.kind === 'composite';
            return (
              <div key={name} role="group">
                <TreeRow
                  depth={1}
                  icon={composite ? Icon.composite : Icon.type}
                  expanded={texp}
                  onToggle={() => toggle(tkey, false)}
                  label={
                    <>
                      {name} <span className="ver">@{newest.version}</span>
                    </>
                  }
                  title={`${newest.category}${composite ? ' · composite' : ''}\n${newest.description}`}
                  active={versions.some((v) => v.file === active) && !texp}
                  testId={`type-${lib.folder}-${name}`}
                  onActivate={() => open(newest.file)}
                  menu={() => typeMenu(newest)}
                  openMenu={menu.open}
                  onRename={() => renameBlockTypeDialog(newest)}
                  trailing={
                    <>
                      {composite && <span className="kind-badge">composite</span>}
                      {versions.length > 1 && <span className="tree-sub">{plural(versions.length, 'version')}</span>}
                      <DiagBadges diags={versions.flatMap((v) => diagsOf(model, v.file))} />
                    </>
                  }
                />
                {texp &&
                  versions.map((v) => (
                    <TreeRow
                      key={v.file}
                      depth={2}
                      label={<span className="ver">@{v.version}</span>}
                      title={v.file}
                      active={active === v.file}
                      onActivate={() => open(v.file)}
                      menu={() => typeMenu(v)}
                      openMenu={menu.open}
                      onRename={() => renameBlockTypeDialog(v)}
                      trailing={<DiagBadges diags={diagsOf(model, v.file)} />}
                    />
                  ))}
              </div>
            );
          })}
      </div>
    );
  };

  const hierarchyOpen = isOpen('s:hierarchy', true);
  const root = model.root;

  return (
    <div className="tree scroll" ref={treeRef} role="tree" aria-label="Project tree">
      <Section id="project" title="Project" open={isOpen('s:project', true)} onToggle={() => toggle('s:project', true)}>
        <TreeRow
          depth={0}
          icon={Icon.project}
          label={model.meta.name}
          title={`Project: ${PROJECT_FILE}`}
          active={active === PROJECT_FILE}
          onActivate={() => open(PROJECT_FILE)}
          openMenu={menu.open}
          onRename={() => renameProject()}
          menu={() => [
            { section: model.meta.name },
            { label: 'Open', onClick: () => open(PROJECT_FILE) },
            { label: 'Settings…', hint: keys('Mod+,'), onClick: () => openSettings('project') },
            'separator',
            { label: 'Rename…', hint: 'F2', onClick: () => renameProject() },
          ]}
          trailing={<DiagBadges diags={diagsOf(model, PROJECT_FILE)} />}
          testId="project-file"
        />
        <TreeRow
          depth={0}
          icon={Icon.doc}
          label="README.md"
          title={'README.md' in files ? 'Project introduction (README.md)' : 'Add the project introduction (README.md)'}
          active={active === 'README.md'}
          className={'README.md' in files ? '' : 'missing'}
          onActivate={() => editFolderDescription(root)}
          onRename={() => store().toast('The project introduction is always README.md')}
          openMenu={menu.open}
          menu={() => [{ label: 'README.md' in files ? 'Open' : 'Add project introduction', onClick: () => editFolderDescription(root) }]}
        />
      </Section>

      <Section
        id="hierarchy"
        title="Hierarchy"
        open={hierarchyOpen}
        onToggle={() => toggle('s:hierarchy', true)}
        count={model.strategies.length + model.sequences.length}
        countTitle={`${plural(model.strategies.length, 'continuous strategy', 'continuous strategies')}, ${plural(model.sequences.length, 'sequence strategy', 'sequence strategies')}`}
        actions={
          <>
            <ActBtn title={`New top-level folder${levels[0] ? ` (${levels[0]})` : ''}`} onClick={() => newFolder(root, levels[0])}>
              {Icon.newFolder}
            </ActBtn>
            <ActBtn title="New strategy at top level (continuous or sequence)" onClick={(el) => menu.openBelow(el, newStrategyItems(''))}>
              {Icon.newFile}
            </ActBtn>
          </>
        }
      >
        <div
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            menu.open(e, [
              { label: 'New top-level folder…', hint: levels[0], onClick: () => newFolder(root, levels[0]) },
              ...newStrategyItems(''),
            ]);
          }}
          className="tree-group"
        >
          {root.folders.map((f) => renderFolder(f, 0))}
          {root.strategies.map((f) => renderStrategy(f, 0))}
          {root.sequences.map((f) => renderSequence(f, 0))}
          {!root.folders.length && !root.strategies.length && !root.sequences.length && (
            <div className="tree-empty">
              No strategies yet.{' '}
              <button className="linkish" onClick={() => newFolder(root, levels[0])}>
                Add a {levels[0] ?? 'folder'}
              </button>
              ,{' '}
              <button className="linkish" onClick={() => newStrategy('')}>
                a continuous strategy
              </button>{' '}
              or{' '}
              <button className="linkish" onClick={() => newSequence('')}>
                a sequence strategy
              </button>
              .
            </div>
          )}
        </div>
      </Section>

      <Section
        id="libraries"
        title="Libraries"
        open={isOpen('s:libraries', true)}
        onToggle={() => toggle('s:libraries', true)}
        count={model.libraries.length}
        countTitle={plural(model.libraries.length, 'library')}
        actions={
          <>
            <ActBtn title="New library" onClick={() => newLibrary()}>
              {Icon.plus}
            </ActBtn>
            <ActBtn
              title="More library actions"
              onClick={(el) => {
                menu.openBelow(el, [
                  { label: 'New library…', onClick: () => newLibrary() },
                  { label: 'Import library from project ZIP…', onClick: () => zipInput.current?.click() },
                ]);
              }}
            >
              {Icon.more}
            </ActBtn>
          </>
        }
      >
        <div
          className="tree-group"
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            menu.open(e, [
              { label: 'New library…', onClick: () => newLibrary() },
              { label: 'Import library from project ZIP…', onClick: () => zipInput.current?.click() },
            ]);
          }}
        >
          {model.libraries.map(renderLibrary)}
          {!model.libraries.length && (
            <div className="tree-empty">
              No libraries.{' '}
              <button className="linkish" onClick={() => newLibrary()}>
                Add library…
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section
        id="assets"
        title="Assets"
        open={isOpen('s:assets', true)}
        onToggle={() => toggle('s:assets', true)}
        count={model.assets.length}
        countTitle={plural(model.assets.length, 'asset')}
        actions={
          <ActBtn title="Add image…" onClick={() => imgInput.current?.click()}>
            {Icon.upload}
          </ActBtn>
        }
      >
        {model.assets.map((a) => (
          <TreeRow
            key={a}
            depth={0}
            icon={Icon.image}
            label={a.slice('assets/'.length)}
            title={a}
            active={active === a}
            onActivate={() => open(a)}
            openMenu={menu.open}
            onRename={() => renameAsset(a)}
            menu={() => [
              { section: a.slice('assets/'.length) },
              { label: 'Open', onClick: () => open(a) },
              { label: 'Copy Markdown reference', onClick: () => copyAssetReference(a) },
              'separator',
              { label: 'Rename…', hint: 'F2', onClick: () => renameAsset(a) },
              'separator',
              { label: 'Delete…', danger: true, onClick: () => deleteAsset(a) },
            ]}
          />
        ))}
        {!model.assets.length && (
          <div className="tree-empty">
            No images yet.{' '}
            <button className="linkish" onClick={() => imgInput.current?.click()}>
              Add image…
            </button>
          </div>
        )}
      </Section>

      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        hidden
        data-testid="import-lib-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) importLibraryZip(f);
        }}
      />
      <input
        ref={imgInput}
        type="file"
        accept="image/*"
        hidden
        data-testid="add-image-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) addAsset(f);
        }}
      />
      {menu.element}
    </div>
  );
}

