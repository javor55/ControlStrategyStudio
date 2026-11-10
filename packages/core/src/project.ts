// Project model: the parsed, validated view of all project files.
import { migrateParsed } from './format';
import { loadLibraries, TypeIndex } from './library';
import { classify, PROJECT_FILE, strategyDocFile } from './paths';
import { validateSchema } from './schema';
import { parseDiagram } from './diagram';
import { validateDiagram } from './validate';
import { parseSequence, sequenceRefs, validateSequence, type SequenceRef } from './sequence';
import { BUILTIN_CATEGORIES, DEFAULT_DRAWING, IMPLICIT_SEQUENCER, type BuiltinCategory, type SignalCategory, type Diag, type DrawingStyle, type Files, type FolderNode, type LibraryDef, type LineStyle, type LinkInst, type ProjectMeta, type Sequence, type Strategy, type WireStyle } from './types';
import { isObj, lineAt, parseYaml, pickExt, str } from './yamlutil';

export const DEFAULT_LEVELS = ['Enterprise', 'Site', 'Area', 'Unit', 'Equipment Module', 'Control Module'];

export interface CrossRef {
  /** Strategy that pulls the signal. */
  strategy: Strategy;
  link: LinkInst;
}

export interface ProjectModel {
  files: Files;
  meta: ProjectMeta;
  libraries: LibraryDef[];
  types: TypeIndex;
  strategies: Strategy[];
  strategyByName: ReadonlyMap<string, Strategy>;
  strategyByFile: ReadonlyMap<string, Strategy>;
  /** Sequences (SFC), sharing the name space of strategies. */
  sequences: Sequence[];
  sequenceByName: ReadonlyMap<string, Sequence>;
  sequenceByFile: ReadonlyMap<string, Sequence>;
  /** Signals of a strategy read (conditions) or written (actions) by sequences. */
  sequenceRefs(strategy: string, block?: string): SequenceRef[];
  /** Hierarchy tree of `strategies/`. */
  root: FolderNode;
  /** Markdown files (READMEs and strategy descriptions). */
  docs: string[];
  assets: string[];
  diags: Diag[];
  diagsByFile: ReadonlyMap<string, Diag[]>;
  /** Links in other strategies that read outputs of `strategy` (optionally one block). */
  usedBy(strategy: string, block?: string): CrossRef[];
}

function parseMeta(files: Files, diags: Diag[]): ProjectMeta {
  const meta: ProjectMeta = { name: 'Untitled project', levels: DEFAULT_LEVELS, titleBlock: {}, signalCategories: {}, drawing: DEFAULT_DRAWING, ext: {} };
  const text = files[PROJECT_FILE];
  if (typeof text !== 'string') {
    diags.push({ severity: 'warning', code: 'missing-project-file', message: `${PROJECT_FILE} is missing`, file: PROJECT_FILE });
    return meta;
  }
  const raw = parseYaml(text);
  if (raw.error) {
    diags.push({ severity: 'error', code: 'yaml-syntax', message: raw.error.message, file: PROJECT_FILE, line: raw.error.line });
    return meta;
  }
  const m = migrateParsed(raw, 'project', PROJECT_FILE);
  const p = m.parsed;
  diags.push(...m.diags, ...validateSchema('project', p, PROJECT_FILE));
  const d = isObj(p.data) ? p.data : {};
  const tb = isObj(d.title_block) ? d.title_block : {};
  return {
    uid: str(d.uid),
    name: str(d.name) ?? meta.name,
    description: str(d.description),
    author: str(d.author),
    // `levels: []` = no level names; a missing key keeps the historic default.
    levels: Array.isArray(d.levels) ? d.levels.map(String) : DEFAULT_LEVELS,
    titleBlock: { logo: str(tb.logo), drawn: str(tb.drawn), checked: str(tb.checked), approved: str(tb.approved) },
    signalCategories: isObj(d.signal_categories)
      ? Object.fromEntries(
          Object.entries(d.signal_categories).map(([k, v]) => {
            const c = isObj(v) ? v : {};
            const style = c.style === 'dashed' || c.style === 'dotted' || c.style === 'solid' || c.style === 'dashdot' ? c.style : undefined;
            return [k, { color: str(c.color), style, width: typeof c.width === 'number' ? c.width : undefined, description: str(c.description) }];
          }),
        )
      : {},
    drawing: parseDrawing(d.drawing),
    ext: pickExt(d),
  };
}

/**
 * Line categories with the built-in ones (bool / numeric / other) always
 * present. Older projects styled lines in `drawing.signals`; those settings
 * are used when the built-in category is not defined.
 */
export function lineCategories(meta: ProjectMeta): Record<string, SignalCategory> {
  const legacy = { bool: meta.drawing.signals.bool, numeric: meta.drawing.signals.real, other: meta.drawing.signals.other };
  const out: Record<string, SignalCategory> = {};
  for (const k of Object.keys(BUILTIN_CATEGORIES) as BuiltinCategory[]) {
    const own = meta.signalCategories[k];
    const l = legacy[k];
    out[k] = own ?? { color: l.color, style: l.style, width: l.width, description: BUILTIN_CATEGORIES[k] };
    if (!out[k].description) out[k] = { ...out[k], description: BUILTIN_CATEGORIES[k] };
  }
  for (const [k, v] of Object.entries(meta.signalCategories)) if (!(k in out)) out[k] = v;
  return out;
}

const LINE_STYLES = ['solid', 'dashed', 'dotted', 'dashdot'] as const;

function parseWire(v: unknown): WireStyle {
  const w = isObj(v) ? v : {};
  return {
    color: str(w.color),
    style: LINE_STYLES.includes(w.style as never) ? (w.style as LineStyle) : undefined,
    width: typeof w.width === 'number' ? w.width : undefined,
  };
}

function parseDrawing(v: unknown): DrawingStyle {
  const d = isObj(v) ? v : {};
  const sig = isObj(d.signals) ? d.signals : {};
  const fb = isObj(d.feedback) ? d.feedback : {};
  return {
    signals: { bool: parseWire(sig.bool), real: parseWire(sig.real), other: parseWire(sig.other) },
    feedback: {
      mark: fb.mark !== false,
      style: fb.style === 'same' || LINE_STYLES.includes(fb.style as never) ? (fb.style as LineStyle | 'same') : DEFAULT_DRAWING.feedback.style,
      color: str(fb.color),
    },
    params: d.params === 'hide' ? 'hide' : 'show',
  };
}

function buildTree(folders: Iterable<string>, strategies: Strategy[], sequences: Sequence[], readmes: Map<string, string>, levels: string[]): FolderNode {
  const root: FolderNode = { path: '', name: '', depth: 0, folders: [], strategies: [], sequences: [], readme: readmes.get('') };
  const nodes = new Map<string, FolderNode>([['', root]]);
  const ensure = (path: string): FolderNode => {
    const hit = nodes.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const parent = ensure(i < 0 ? '' : path.slice(0, i));
    const depth = parent.depth + 1;
    const node: FolderNode = {
      path,
      name: path.slice(i + 1),
      depth,
      level: levels[depth - 1],
      readme: readmes.get(path),
      folders: [],
      strategies: [],
      sequences: [],
    };
    parent.folders.push(node);
    nodes.set(path, node);
    return node;
  };
  for (const f of folders) ensure(f);
  for (const s of strategies) ensure(s.folder).strategies.push(s.file);
  for (const s of sequences) ensure(s.folder).sequences.push(s.file);
  const sort = (n: FolderNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.strategies.sort();
    n.sequences.sort();
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function loadProject(files: Files): ProjectModel {
  const diags: Diag[] = [];
  const meta = parseMeta(files, diags);
  const lib = loadLibraries(files);
  diags.push(...lib.diags);

  const strategies: Strategy[] = [];
  const sequences: Sequence[] = [];
  const readmes = new Map<string, string>();
  const folders = new Set<string>();
  const docs: string[] = [];
  const assets: string[] = [];
  const parsedByFile = new Map<string, ReturnType<typeof parseYaml>>();

  for (const [file, content] of Object.entries(files)) {
    const role = classify(file);
    if (role.kind === 'asset') assets.push(file);
    if (role.kind === 'readme') {
      docs.push(file);
      if (role.folder !== null) {
        readmes.set(role.folder, file);
        if (role.folder) folders.add(role.folder);
      }
    }
    if (role.kind === 'strategy-doc') docs.push(file);
    if (role.kind === 'sequence' && typeof content === 'string') {
      const raw = parseYaml(content);
      const mig = migrateParsed(raw, 'sequence', file);
      const p = mig.parsed;
      parsedByFile.set(file, p);
      const doc = typeof files[strategyDocFile(file)] === 'string' ? strategyDocFile(file) : undefined;
      if (p.error) {
        diags.push({ severity: 'error', code: 'yaml-syntax', message: p.error.message, file, line: p.error.line });
        sequences.push({ file, name: role.name, folder: role.folder, sheets: [{ id: 1 }], steps: [], transitions: [], inputs: [], sequencers: [{ id: IMPLICIT_SEQUENCER, ext: {} }], explicitSequencers: false, notes: [], ext: {}, docFile: doc });
        continue;
      }
      diags.push(...mig.diags, ...validateSchema('sequence', p, file));
      const r = parseSequence(file, role.name, role.folder, p);
      diags.push(...r.diags);
      if (r.sequence.name !== role.name) {
        diags.push({ severity: 'warning', code: 'name-mismatch', message: `Sequence "${r.sequence.name}" is stored in ${role.name}.seq.yaml`, file, line: lineAt(p, ['sequence']) });
      }
      sequences.push({ ...r.sequence, docFile: doc });
      continue;
    }
    if (role.kind !== 'strategy' || typeof content !== 'string') continue;

    const mig = migrateParsed(parseYaml(content), 'strategy', file);
    const p = mig.parsed;
    parsedByFile.set(file, p);
    const base: Strategy = {
      file,
      name: role.name,
      folder: role.folder,
      sheets: [{ id: 1 }],
      blocks: [],
      links: [],
      notes: [],
      ext: {},
      docFile: typeof files[strategyDocFile(file)] === 'string' ? strategyDocFile(file) : undefined,
    };
    if (p.error) {
      diags.push({ severity: 'error', code: 'yaml-syntax', message: p.error.message, file, line: p.error.line });
      strategies.push(base);
      continue;
    }
    diags.push(...mig.diags, ...validateSchema('strategy', p, file));
    const d = isObj(p.data) ? p.data : {};
    const name = str(d.strategy) ?? role.name;
    if (name !== role.name) {
      diags.push({ severity: 'warning', code: 'name-mismatch', message: `Strategy "${name}" is stored in ${role.name}.yaml`, file, line: lineAt(p, ['strategy']) });
    }
    const res = parseDiagram(d, (ref) => lib.index.resolve(ref), { file, parsed: p, base: [] });
    diags.push(...res.diags);
    strategies.push({
      ...base,
      ...res.diagram,
      uid: str(d.uid),
      name,
      title: str(d.title),
      description: str(d.description),
      revision: str(d.revision),
      author: str(d.author),
      scan: str(d.scan),
      ext: pickExt(d),
    });
  }
  strategies.sort((a, b) => a.file.localeCompare(b.file));
  sequences.sort((a, b) => a.file.localeCompare(b.file));

  // Strategies and sequences share one name space (references `NAME:…`).
  const byName = new Map<string, Strategy>();
  const seqByName = new Map<string, Sequence>();
  const owner = new Map<string, string>();
  for (const s of [...strategies, ...sequences]) {
    const other = owner.get(s.name);
    if (other) {
      diags.push({ severity: 'error', code: 'duplicate-strategy', message: `Name "${s.name}" is also used by ${other}`, file: s.file });
      continue;
    }
    owner.set(s.name, s.file);
    if ('blocks' in s) byName.set(s.name, s);
    else seqByName.set(s.name, s);
  }

  for (const s of strategies) {
    const p = parsedByFile.get(s.file);
    if (!p || p.error) continue;
    diags.push(...validateDiagram(s, { file: s.file, parsed: p, base: [], strategies: byName, sequences: seqByName }));
    for (const l of s.links) {
      if (l.category && !meta.signalCategories[l.category] && !(l.category in BUILTIN_CATEGORIES)) {
        diags.push({ severity: 'warning', code: 'unknown-category', message: `Link ${l.index + 1}: line category "${l.category}" is not defined (Settings → Drawing style)`, file: s.file, line: lineAt(p, ['links', l.index, 'category']), link: l.index });
      }
    }
  }
  const seqRefs = new Map<string, SequenceRef[]>();
  for (const q of sequences) {
    const p = parsedByFile.get(q.file);
    if (p && !p.error) diags.push(...validateSequence(q, p, { strategies: byName, sequences: seqByName }));
    for (const r of sequenceRefs(q)) seqRefs.set(r.strategy, [...(seqRefs.get(r.strategy) ?? []), r]);
  }
  // One input written by several sequences: their actions fight over it.
  const writers = new Map<string, SequenceRef[]>();
  for (const rs of seqRefs.values()) for (const r of rs) if (r.kind === 'writes') writers.set(`${r.strategy}:${r.block}.${r.port}`, [...(writers.get(`${r.strategy}:${r.block}.${r.port}`) ?? []), r]);
  for (const [target, rs] of writers) {
    const seqs = [...new Set(rs.map((r) => r.sequence))];
    if (seqs.length < 2) continue;
    for (const r of rs) {
      const others = seqs.filter((x) => x !== r.sequence);
      const p = parsedByFile.get(r.sequenceFile);
      diags.push({
        severity: 'warning',
        code: 'multiple-writers',
        message: `${r.step} action ${(r.action ?? 0) + 1}: ${target} is also written by ${others.join(', ')} — make sure they never run at the same time`,
        file: r.sequenceFile,
        line: p ? lineAt(p, ['steps', r.step!, 'actions', r.action ?? 0]) : undefined,
        block: r.step,
      });
    }
  }
  for (const t of lib.index.all) {
    if (!t.diagram) continue;
    const p = migrateParsed(parseYaml(files[t.file] as string), 'blocktype', t.file).parsed;
    diags.push(...validateDiagram(t.diagram, { file: t.file, parsed: p, base: ['diagram'], composite: t }));
  }

  // Reverse cross-references (who reads signals of which strategy).
  const refs = new Map<string, CrossRef[]>();
  for (const s of strategies) {
    for (const l of s.links) {
      if (!l.from.strategy) continue;
      const list = refs.get(l.from.strategy) ?? [];
      list.push({ strategy: s, link: l });
      refs.set(l.from.strategy, list);
    }
  }

  const diagsByFile = new Map<string, Diag[]>();
  for (const d of diags) {
    const k = d.file ?? '';
    diagsByFile.set(k, [...(diagsByFile.get(k) ?? []), d]);
  }

  return {
    files,
    meta,
    libraries: lib.libraries,
    types: lib.index,
    strategies,
    strategyByName: byName,
    strategyByFile: new Map(strategies.map((s) => [s.file, s])),
    root: buildTree(folders, strategies, sequences, readmes, meta.levels),
    sequences,
    sequenceByName: seqByName,
    sequenceByFile: new Map(sequences.map((s) => [s.file, s])),
    sequenceRefs(strategy, block) {
      return (seqRefs.get(strategy) ?? []).filter((r) => !block || r.block === block);
    },
    docs: docs.sort(),
    assets: assets.sort(),
    diags,
    diagsByFile,
    usedBy(strategy, block) {
      return (refs.get(strategy) ?? []).filter((r) => !block || r.link.from.block === block);
    },
  };
}
