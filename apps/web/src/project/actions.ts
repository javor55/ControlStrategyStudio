// User actions of the project tree (and the block type / project views).
// Every change goes through store().dispatch with a core Op.
import {
  basename,
  blockTypeFile,
  bumpVersion,
  classify,
  folderReadme,
  joinPath,
  libraryFile,
  sequenceFile,
  strategyDocFile,
  strategyFile,
  wireKind,
  BUILTIN_CATEGORIES,
  type BlockInst,
  type BlockTypeDef,
  type FolderNode,
  type LinkInst,
  type Op,
} from '@csd/core';
import { store } from '../state/store';
import { zipToFiles } from '../state/persist';
import { confirmDialog, pickFolderDialog, promptDialog, type PickFolder } from '../ui/dialogs';
import { plural } from '../ui/text';
import { setProjectField } from '../settings/projectFields';

const TAG = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_FOLDER_CHARS = /[\\/:*?"<>|]/;

const st = () => store().getState();

function validateStrategyName(v: string, except?: string): string | undefined {
  if (!v) return 'Enter a name';
  if (!TAG.test(v)) return 'Use letters, digits, "_" or "-", starting with a letter or "_"';
  if (v === 'in' || v === 'out') return `"${v}" is reserved`;
  const other = st().model.strategyByName.get(v) ?? st().model.sequenceByName.get(v);
  if (other && other.file !== except) return `Already used by ${other.file}`;
  return undefined;
}

const isSequenceFile = (file: string) => classify(file).kind === 'sequence';

/** Path of a strategy or sequence (same kind as `file`) named `name` in `folder`. */
function sameKindFile(file: string, folder: string, name: string): string {
  return isSequenceFile(file) ? sequenceFile(folder, name) : strategyFile(folder, name);
}

/** Name and folder of a strategy or sequence file. */
function entityOf(file: string): { name: string; folder: string; kind: 'strategy' | 'sequence' } {
  const role = classify(file);
  const m = st().model;
  const seq = m.sequenceByFile.get(file);
  const strat = m.strategyByFile.get(file);
  const folder = role.kind === 'strategy' || role.kind === 'sequence' ? role.folder : '';
  const fallback = role.kind === 'strategy' || role.kind === 'sequence' ? role.name : basename(file);
  return { name: seq?.name ?? strat?.name ?? fallback, folder, kind: role.kind === 'sequence' ? 'sequence' : 'strategy' };
}

function validateFolderSegment(v: string): string | undefined {
  if (!v) return 'Enter a name';
  if (v === '.' || v === '..' || BAD_FOLDER_CHARS.test(v)) return 'Not a valid folder name';
  return undefined;
}

function validateFolderPath(v: string): string | undefined {
  if (!v) return undefined; // top level
  for (const seg of v.replace(/^\/+|\/+$/g, '').split('/')) {
    const e = validateFolderSegment(seg);
    if (e) return `${e}: "${seg}"`;
  }
  return undefined;
}

const cleanFolder = (v: string) => v.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');

/** Files stored under a hierarchy folder (recursively). */
export function filesUnderFolder(path: string): string[] {
  const prefix = joinPath('strategies', path) + '/';
  return Object.keys(st().files).filter((f) => f.startsWith(prefix));
}

// --- hierarchy -----------------------------------------------------------------------

export async function newStrategy(folder: string) {
  const name = await promptDialog({
    title: 'New continuous strategy',
    message: `${folder ? `In ${folder}` : 'At the top of the hierarchy'} · function blocks and links (FBD)`,
    label: 'Name (tag)',
    placeholder: 'e.g. FIC101',
    okLabel: 'Create',
    validate: (v) => validateStrategyName(v),
  });
  if (!name) return;
  if (store().dispatch({ op: 'createStrategy', folder, name }, { label: `New continuous strategy ${name}` })) store().open(strategyFile(folder, name));
}

export async function newSequence(folder: string) {
  const name = await promptDialog({
    title: 'New sequence strategy',
    message: `${folder ? `In ${folder}` : 'At the top of the hierarchy'} · steps, transitions and actions (SFC / Grafcet)`,
    label: 'Name (tag)',
    placeholder: 'e.g. FILL_T100',
    okLabel: 'Create',
    validate: (v) => validateStrategyName(v),
  });
  if (!name) return;
  if (store().dispatch({ op: 'createSequence', folder, name }, { label: `New sequence strategy ${name}` })) store().open(sequenceFile(folder, name));
}

export async function newFolder(parent: FolderNode, level?: string): Promise<string | undefined> {
  const name = await promptDialog({
    title: parent.path ? 'New subfolder' : 'New top-level folder',
    message: [parent.path ? `In ${parent.path}` : '', level ? `Hierarchy level: ${level}` : ''].filter(Boolean).join(' · ') || undefined,
    label: 'Folder name',
    okLabel: 'Create',
    validate: (v) => validateFolderSegment(v) ?? (parent.folders.some((f) => f.name === v) ? 'A folder with this name already exists' : undefined),
  });
  if (!name) return undefined;
  const path = joinPath(parent.path, name);
  return store().dispatch({ op: 'createFolder', folder: path }, { label: `New folder ${name}` }) ? path : undefined;
}

export function editFolderDescription(node: FolderNode) {
  const readme = node.path ? folderReadme(node.path) : 'README.md';
  if (!(readme in st().files)) {
    const ok = node.path
      ? store().dispatch({ op: 'createFolder', folder: node.path }, { label: 'Add folder description' })
      : store().dispatch({ op: 'createFile', file: readme, content: `# ${st().model.meta.name}\n` }, { label: 'Add project introduction' });
    if (!ok) return;
  }
  store().open(readme);
}

export async function deleteFolder(node: FolderNode) {
  const files = filesUnderFolder(node.path);
  const strategies = files.filter((f) => classify(f).kind === 'strategy').length;
  const sequences = files.filter((f) => classify(f).kind === 'sequence').length;
  const ok = await confirmDialog({
    title: `Delete folder ${node.name}?`,
    message: `${node.path} and everything in it will be deleted: ${[plural(strategies, 'continuous strategy', 'continuous strategies'), sequences ? plural(sequences, 'sequence strategy', 'sequence strategies') : ''].filter(Boolean).join(', ')}; ${plural(files.length, 'file')} in total.`,
    okLabel: 'Delete folder',
    danger: true,
  });
  if (!ok || !files.length) return;
  if (store().dispatch({ op: 'batch', label: `Delete folder ${node.name}`, ops: files.map((file): Op => ({ op: 'deleteFile', file })) }, { label: `Delete folder ${node.name}` }))
    store().toastUndo(`Deleted folder ${node.name}`);
}

export async function renameStrategy(file: string) {
  const e = entityOf(file);
  const old = e.name;
  const name = await promptDialog({
    title: `Rename ${old}`,
    message: e.kind === 'sequence' ? 'References from strategies are updated too.' : 'References from other strategies and sequences are updated too.',
    label: 'New name',
    value: old,
    okLabel: 'Rename',
    validate: (v) => validateStrategyName(v, file),
  });
  if (!name || name === old) return;
  const wasActive = st().activeFile === file;
  if (store().dispatch({ op: 'renameStrategy', file, name }, { label: `Rename ${old} → ${name}` }) && wasActive) {
    store().open(sameKindFile(file, e.folder, name));
  }
}

export async function duplicateStrategy(file: string) {
  const e = entityOf(file);
  const old = e.name;
  let suggestion = `${old}_copy`;
  for (let i = 2; st().model.strategyByName.has(suggestion) || st().model.sequenceByName.has(suggestion); i++) suggestion = `${old}_copy${i}`;
  const name = await promptDialog({ title: `Duplicate ${old}`, label: 'Name of the copy', value: suggestion, okLabel: 'Duplicate', validate: (v) => validateStrategyName(v) });
  if (!name) return;
  if (store().dispatch({ op: 'duplicateStrategy', file, name }, { label: `Duplicate ${old}` })) store().open(sameKindFile(file, e.folder, name));
}

export async function moveStrategy(file: string) {
  const role = classify(file);
  if (role.kind !== 'strategy' && role.kind !== 'sequence') return;
  const m = st().model;
  const levels = m.meta.levels;
  const folders: PickFolder[] = [{ path: '', name: m.meta.name || 'Top level', depth: 0 }];
  const walk = (n: FolderNode, depth: number) => {
    for (const f of n.folders) {
      folders.push({ path: f.path, name: f.name, depth, level: f.level });
      walk(f, depth + 1);
    }
  };
  walk(m.root, 1);
  const raw = await pickFolderDialog({
    title: `Move ${role.name} to folder`,
    folders,
    current: role.folder,
    okLabel: 'Move',
    levelAt: (depth) => levels[depth - 1] ?? undefined,
  });
  if (raw === null) return;
  const folder = cleanFolder(raw);
  if (folder === role.folder || validateFolderPath(folder)) return;
  const wasActive = st().activeFile === file;
  if (store().dispatch({ op: 'moveStrategy', file, folder }, { label: `Move ${role.name}` })) {
    if (wasActive) store().open(sameKindFile(file, folder, role.name));
    store().toastUndo(`Moved ${role.name} to ${folder || 'the top level'}`);
  }
}

export function openFunctionDescription(file: string) {
  const md = strategyDocFile(file);
  if (!(md in st().files)) {
    if (!store().dispatch({ op: 'createFile', file: md, content: '## Function\n\n' }, { label: 'Add function description' })) return;
  }
  store().open(md);
}

export async function deleteStrategy(file: string) {
  const name = entityOf(file).name;
  const md = strategyDocFile(file);
  const m = st().model;
  const readers = [
    ...new Set([
      ...m.usedBy(name).map((r) => r.strategy.name),
      // Sequences that read or write signals of this strategy.
      ...m.sequenceRefs(name).map((r) => r.sequence),
      // Strategies whose signals a deleted sequence reads or writes.
      ...(m.sequenceByFile.has(file) ? m.strategies.filter((x) => m.sequenceRefs(x.name).some((r) => r.sequenceFile === file)).map((x) => x.name) : []),
    ]),
  ].filter((n) => n !== name);
  const ok = await confirmDialog({
    title: `Delete ${name}?`,
    message:
      `${file}${md in st().files ? ' and its function description' : ''} will be deleted.` +
      (readers.length ? ` It is connected to ${readers.join(', ')} (signals read or written).` : ''),
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const ops: Op[] = [{ op: 'deleteFile', file }];
  if (md in st().files) ops.push({ op: 'deleteFile', file: md });
  if (store().dispatch({ op: 'batch', label: `Delete ${name}`, ops }, { label: `Delete ${name}` })) store().toastUndo(`Deleted ${name}`);
}

// --- libraries -------------------------------------------------------------------------

export async function newLibrary() {
  const folder = await promptDialog({
    title: 'New library',
    message: 'A library is a self-contained folder library/<name>/ that can be copied to other projects.',
    label: 'Folder name',
    placeholder: 'e.g. acme',
    okLabel: 'Create',
    validate: (v) =>
      !v ? 'Enter a name' : !TAG.test(v) ? 'Use letters, digits, "_" or "-"' : st().model.libraries.some((l) => l.folder === v) || libraryFile(v) in st().files ? 'Library already exists' : undefined,
  });
  if (!folder) return;
  if (store().dispatch({ op: 'createLibrary', folder }, { label: `New library ${folder}` })) store().open(libraryFile(folder));
}

export async function newBlockType(lib: string, kind: 'basic' | 'composite') {
  const type = await promptDialog({
    title: kind === 'composite' ? 'New composite block type' : 'New basic block type',
    message: `In library ${lib}`,
    label: 'Type name',
    placeholder: 'e.g. VALVE_2POS',
    okLabel: 'Next',
    validate: (v) =>
      !v
        ? 'Enter a name'
        : !TYPE_NAME.test(v)
          ? 'Use letters, digits and "_", starting with a letter'
          : st().model.types.versions(v, lib).length || Object.keys(st().files).some((f) => f.startsWith(`library/${lib}/${v}@`))
            ? `${v} already exists in ${lib} — create a new version instead`
            : undefined,
  });
  if (!type) return;
  const category = await promptDialog({ title: `Category of ${type}`, label: 'Category (palette group)', value: 'Custom', okLabel: 'Create', validate: (v) => (v ? undefined : 'Enter a category') });
  if (category === null) return;
  if (store().dispatch({ op: 'createBlockType', lib, type, category, kind }, { label: `New block type ${type}` })) store().open(blockTypeFile(lib, type, '1.0.0'));
}

export function newTypeVersion(def: BlockTypeDef) {
  const version = bumpVersion(def.version, 'minor');
  if (store().dispatch({ op: 'newTypeVersion', file: def.file, part: 'minor' }, { label: `New version ${def.type}@${version}` })) {
    store().open(blockTypeFile(def.library, def.type, version));
    store().toast(`Created ${def.type}@${version}`);
  }
}

/** Places (strategy or composite type) whose blocks resolve to exactly this definition. */
export function usagesOf(def: BlockTypeDef): { file: string; strategy?: string; block: string; sheet: number; label: string }[] {
  const m = st().model;
  const out: { file: string; strategy?: string; block: string; sheet: number; label: string }[] = [];
  for (const s of m.strategies) for (const b of s.blocks) if (b.def === def) out.push({ file: s.file, strategy: s.name, block: b.id, sheet: b.sheet, label: s.name });
  for (const t of m.types.all)
    for (const b of t.diagram?.blocks ?? []) if (b.def === def) out.push({ file: t.file, block: b.id, sheet: b.sheet, label: `${t.library}/${t.type}@${t.version}` });
  return out;
}

export async function deleteTypeVersion(def: BlockTypeDef) {
  const uses = usagesOf(def);
  const others = st().model.types.versions(def.type, def.library).filter((t) => t !== def);
  const ok = await confirmDialog({
    title: `Delete ${def.type}@${def.version}?`,
    message:
      `${def.file} will be deleted.` +
      (uses.length ? ` ${plural(uses.length, 'block')} ${uses.length === 1 ? 'uses' : 'use'} this version${others.length ? ' and will switch to another one' : ' and will become unknown'}.` : ''),
    okLabel: 'Delete version',
    danger: true,
  });
  if (!ok) return;
  if (store().dispatch({ op: 'deleteFile', file: def.file }, { label: `Delete ${def.type}@${def.version}` })) {
    if (others[0] && st().activeFile === null) store().open(others[0].file);
    store().toastUndo(`Deleted ${def.type}@${def.version}`);
  }
}

export async function importLibraryZip(zip: File) {
  let files;
  try {
    files = await zipToFiles(zip);
  } catch (e) {
    store().toast(`Cannot read ${zip.name}: ${(e as Error).message}`, 'error');
    return;
  }
  const found = new Set<string>();
  for (const f of Object.keys(files)) {
    const m = /^library\/([^/]+)\//.exec(f);
    if (m) found.add(m[1]);
  }
  const here = Object.keys(st().files);
  const exists = (lib: string) => here.some((f) => f.startsWith(`library/${lib}/`));
  const available = [...found].filter((l) => !exists(l)).sort();
  if (!available.length) {
    store().toast(found.size ? `All libraries in ${zip.name} already exist here (${[...found].join(', ')})` : `${zip.name} contains no libraries`, 'error');
    return;
  }
  const skipped = [...found].filter(exists);
  const answer = await promptDialog({
    title: 'Import libraries',
    message: `New in ${zip.name}: ${available.join(', ')}.${skipped.length ? ` Already here (skipped): ${skipped.join(', ')}.` : ''} Edit the list to import only some.`,
    label: 'Libraries (comma separated)',
    value: available.join(', '),
    okLabel: 'Import',
    validate: (v) => {
      const list = v.split(/[\s,]+/).filter(Boolean);
      if (!list.length) return 'Choose at least one library';
      const bad = list.filter((l) => !available.includes(l));
      return bad.length ? `Not available: ${bad.join(', ')}` : undefined;
    },
  });
  if (!answer) return;
  const libs = [...new Set(answer.split(/[\s,]+/).filter(Boolean))];
  const ops: Op[] = [];
  for (const [file, content] of Object.entries(files)) if (libs.some((l) => file.startsWith(`library/${l}/`))) ops.push({ op: 'createFile', file, content });
  if (store().dispatch({ op: 'batch', label: 'Import libraries', ops }, { label: `Import ${libs.join(', ')}` })) {
    const types = ops.filter((o) => o.op === 'createFile' && classify(o.file).kind === 'blocktype').length;
    store().toast(`Imported ${libs.join(', ')} (${plural(types, 'block type file')})`);
  }
}

// --- assets ----------------------------------------------------------------------------

export async function addAsset(file: File) {
  const name = file.name.replace(/[^\w.-]+/g, '_') || 'image';
  const path = `assets/${name}`;
  const content = /\.svg$/i.test(name) || file.type === 'image/svg+xml' ? await file.text() : new Uint8Array(await file.arrayBuffer());
  const ops: Op[] = [];
  if (path in st().files) {
    const ok = await confirmDialog({ title: `Replace ${path}?`, message: 'An asset with this name already exists.', okLabel: 'Replace', danger: true });
    if (!ok) return;
    ops.push({ op: 'deleteFile', file: path });
  }
  ops.push({ op: 'createFile', file: path, content });
  if (store().dispatch({ op: 'batch', label: `Add ${name}`, ops }, { label: `Add ${name}` })) {
    store().toast(`Added ${path}`);
  }
}

// --- signal categories -----------------------------------------------------------------

/** Colours offered to new signal categories (first one not yet used). */
const CATEGORY_COLORS = ['#b3261e', '#6b7280', '#8a5a12', '#6a3fa0', '#0f766e', '#c2410c', '#1d4ed8', '#be185d'];

export function defaultCategoryColor(): string {
  const used = new Set(Object.values(st().model.meta.signalCategories).map((c) => c.color?.toLowerCase()));
  return CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[Object.keys(st().model.meta.signalCategories).length % CATEGORY_COLORS.length];
}

/**
 * Number of links (strategies and composite internals) per line category.
 * Links without a category count for their built-in one (bool / numeric / other).
 */
export function categoryUsage(): Map<string, number> {
  const m = st().model;
  const out = new Map<string, number>();
  const BUILTIN = { bool: 'bool', real: 'numeric', other: 'other' } as const;
  const count = (d: { blocks: readonly BlockInst[]; links: readonly LinkInst[] }) => {
    const byId = new Map(d.blocks.map((b) => [b.id, b]));
    for (const l of d.links) {
      let c = l.category;
      if (!c) {
        if (l.from.strategy) continue;
        const t = byId.get(l.to.block)?.def?.inputs.find((p) => p.name === l.to.port)?.type ?? byId.get(l.from.block)?.def?.outputs.find((p) => p.name === l.from.port)?.type;
        c = BUILTIN[wireKind(t)];
      }
      out.set(c, (out.get(c) ?? 0) + 1);
    }
  };
  for (const s of m.strategies) count(s);
  for (const t of m.types.all) if (t.diagram) count(t.diagram);
  return out;
}

/** Asks for the name of a new signal category; null = cancelled. Does not create it. */
export function askCategoryName(): Promise<string | null> {
  return promptDialog({
    title: 'New line category',
    message: 'Links of a category share a line style (colour, dash, width), defined in project.yaml and editable in Settings → Drawing style.',
    label: 'Name',
    placeholder: 'e.g. interlock',
    okLabel: 'Create',
    validate: (v) =>
      !v ? 'Enter a name' : !TAG.test(v) ? 'Use letters, digits, "_" or "-", starting with a letter or "_"' : v in st().model.meta.signalCategories || v in BUILTIN_CATEGORIES ? 'This category already exists' : undefined,
  });
}

/** Renames a hierarchy folder (keeps its parent). Returns the new path, or undefined. */
export async function renameFolder(node: FolderNode): Promise<string | undefined> {
  if (!node.path) return undefined;
  const slash = node.path.lastIndexOf('/');
  const parent = slash < 0 ? '' : node.path.slice(0, slash);
  const name = await promptDialog({
    title: `Rename folder ${node.name}`,
    message: parent ? `In ${parent}` : 'Top-level folder',
    label: 'New name',
    value: node.name,
    okLabel: 'Rename',
    validate: (v) => validateFolderRename(node, v),
  });
  if (!name || name === node.name) return undefined;
  return renameFolderTo(node, name);
}

/** Validation message for a new name of folder `node`, or undefined. */
export function validateFolderRename(node: FolderNode, v: string): string | undefined {
  const slash = node.path.lastIndexOf('/');
  const parent = slash < 0 ? '' : node.path.slice(0, slash);
  if (v.includes('/')) return 'The name cannot contain "/"; use Move to folder for strategies';
  const e = validateFolderSegment(v);
  if (e) return e;
  if (v === node.name) return undefined;
  const to = joinPath(parent, v);
  if (Object.keys(st().files).some((f) => f.startsWith(`strategies/${to}/`))) return 'A folder with this name already exists';
  return undefined;
}

/** Renames folder `node` to `name` (same parent); returns the new path. */
export function renameFolderTo(node: FolderNode, name: string): string | undefined {
  const err = validateFolderRename(node, name);
  if (err) {
    store().toast(err, 'error');
    return undefined;
  }
  if (name === node.name) return node.path;
  const slash = node.path.lastIndexOf('/');
  const parent = slash < 0 ? '' : node.path.slice(0, slash);
  const to = joinPath(parent, name);
  const s = store();
  const active = s.getState().activeFile;
  const sheet = s.getState().activeSheet;
  const selection = s.getState().selection;
  const src = `strategies/${node.path}/`;
  if (!s.dispatch({ op: 'renameFolder', from: node.path, to }, { label: `Rename folder ${node.name} → ${name}` })) return undefined;
  // The store follows a moved active file only for single moves: re-open it at its new path.
  if (active && active.startsWith(src)) {
    const moved = `strategies/${to}/${active.slice(src.length)}`;
    if (moved in s.getState().files) {
      s.open(moved, { sheet, select: selection ?? undefined });
    }
  }
  return to;
}

// --- assets & files ------------------------------------------------------------------------

/** Copies text to the clipboard with a toast. */
export function copyText(text: string, what = 'Copied') {
  const ok = () => store().toast(`${what}: ${text}`);
  if (!navigator.clipboard) return ok();
  navigator.clipboard.writeText(text).then(ok, ok);
}

export function copyAssetReference(path: string) {
  copyText(`![](${path})`, 'Copied Markdown reference');
}

export async function renameAsset(path: string): Promise<string | undefined> {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const next = await promptDialog({
    title: `Rename ${name}`,
    message: 'Markdown documents that show the image are not updated.',
    label: 'New name',
    value: name,
    okLabel: 'Rename',
    validate: (v) => (!v ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'Not a valid file name' : v !== name && `assets/${v}` in st().files ? 'An asset with this name already exists' : undefined),
  });
  if (!next || next === name) return undefined;
  const to = `assets/${next.includes('.') || dot < 0 ? next : next + name.slice(dot)}`;
  const wasActive = st().activeFile === path;
  if (!store().dispatch({ op: 'moveFile', from: path, to }, { label: `Rename ${name}` })) return undefined;
  if (wasActive) store().open(to);
  return to;
}

export async function deleteAsset(path: string) {
  const ok = await confirmDialog({ title: `Delete ${basename(path)}?`, message: `${path} will be deleted. Documents that show it will show a missing image.`, okLabel: 'Delete', danger: true });
  if (!ok) return;
  if (store().dispatch({ op: 'deleteFile', file: path }, { label: `Delete ${path}` })) store().toastUndo(`Deleted ${basename(path)}`);
}

/** Renames the project (project.yaml name) after asking. */
export async function renameProject() {
  const old = st().model.meta.name;
  const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: old, okLabel: 'Rename', validate: (v) => (v ? undefined : 'Enter a name') });
  if (!name || name === old) return;
  setProjectField(['name'], name, 'Rename project');
}

/** Renames a block type (all versions, every usage) after asking for the name. */
export async function renameBlockTypeDialog(def: BlockTypeDef) {
  const m = st().model;
  const versions = m.types.versions(def.type, def.library);
  const uses = versions.reduce((n, t) => n + usagesOf(t).length, 0);
  const to = await promptDialog({
    title: `Rename ${def.type}`,
    message: `All ${plural(versions.length, 'version')} in library ${def.library} are renamed${uses ? ` and ${plural(uses, 'block')} using the type are updated` : ''}.`,
    label: 'New name',
    value: def.type,
    okLabel: 'Rename',
    validate: (v) => (!v ? 'Enter a name' : !TYPE_NAME.test(v) ? 'Use letters, digits and "_", starting with a letter' : v !== def.type && m.types.versions(v, def.library).length ? `${v} already exists in ${def.library}` : undefined),
  });
  if (!to || to === def.type) return;
  const wasActive = versions.some((v) => v.file === st().activeFile);
  if (store().dispatch({ op: 'renameBlockType', file: def.file, type: to }, { label: `Rename type ${def.type} → ${to}` })) {
    if (wasActive) store().open(blockTypeFile(def.library, to, def.version));
    store().toastUndo(`Renamed ${def.type} to ${to}`);
  }
}
