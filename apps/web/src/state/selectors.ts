// Derived views of the editor state shared by all panels.
import { useMemo } from 'react';
import {
  classify,
  layoutSheet,
  type BlockTypeDef,
  type Diag,
  type Diagram,
  type LayoutContext,
  type ProjectModel,
  type SheetLayout,
  type Strategy,
  type YamlPath,
} from '@csd/core';
import { useEditor, type EditorState } from './store';

export type ActiveView =
  | { kind: 'none' }
  | { kind: 'project'; file: string }
  | { kind: 'strategy'; file: string; strategy: Strategy }
  | { kind: 'blocktype'; file: string; type: BlockTypeDef | undefined }
  | { kind: 'library'; file: string; lib: string }
  | { kind: 'doc'; file: string }
  | { kind: 'asset'; file: string }
  | { kind: 'other'; file: string };

export function activeView(s: EditorState): ActiveView {
  const f = s.activeFile;
  if (!f || !(f in s.files)) return { kind: 'none' };
  const role = classify(f);
  switch (role.kind) {
    case 'project':
      return { kind: 'project', file: f };
    case 'strategy': {
      const strategy = s.model.strategyByFile.get(f);
      return strategy ? { kind: 'strategy', file: f, strategy } : { kind: 'other', file: f };
    }
    case 'blocktype':
      return { kind: 'blocktype', file: f, type: s.model.types.all.find((t) => t.file === f) };
    case 'library':
      return { kind: 'library', file: f, lib: role.lib };
    case 'readme':
    case 'strategy-doc':
      return { kind: 'doc', file: f };
    case 'asset':
      return { kind: 'asset', file: f };
    default:
      return { kind: 'other', file: f };
  }
}

/** The diagram edited on the canvas: a strategy, or the inside of a composite block type. */
export interface ActiveDiagram {
  file: string;
  /** YAML path of the diagram body — pass as `root` in diagram ops. */
  root: YamlPath;
  diagram: Diagram;
  strategy?: Strategy;
  composite?: BlockTypeDef;
  layoutContext: LayoutContext;
}

export function activeDiagramOf(s: EditorState): ActiveDiagram | undefined {
  const v = activeView(s);
  if (v.kind === 'strategy') {
    const st = v.strategy;
    const model = s.model;
    return {
      file: v.file,
      root: [],
      diagram: st,
      strategy: st,
      layoutContext: {
        defaultScan: st.scan,
        usedBy: (block, port) =>
          model
            .usedBy(st.name, block)
            .filter((r) => r.link.from.port === port)
            .map((r) => r.strategy.name),
      },
    };
  }
  if (v.kind === 'blocktype' && v.type?.kind === 'composite') {
    return {
      file: v.file,
      root: ['diagram'],
      diagram: v.type.diagram ?? { sheets: [{ id: 1 }], blocks: [], links: [], notes: [] },
      composite: v.type,
      layoutContext: { composite: v.type },
    };
  }
  return undefined;
}

/** Re-computed only when the project model or active file changes. */
export function useActiveDiagram(): ActiveDiagram | undefined {
  const model = useEditor((s) => s.model);
  const file = useEditor((s) => s.activeFile);
  const files = useEditor((s) => s.files);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => activeDiagramOf({ model, activeFile: file, files } as EditorState), [model, file]);
}

export function layoutActiveSheet(d: ActiveDiagram, sheet: number, extra: Partial<LayoutContext> = {}): SheetLayout {
  const valid = d.diagram.sheets.some((x) => x.id === sheet) ? sheet : d.diagram.sheets[0]?.id ?? 1;
  return layoutSheet(d.diagram, valid, { ...d.layoutContext, ...extra });
}

const NO_DIAGS: Diag[] = [];

/** Diagnostics of one file. Returns a stable array, so it is safe inside `useEditor` selectors. */
export function diagsOf(model: ProjectModel, file: string | null | undefined): Diag[] {
  return (file && model.diagsByFile.get(file)) || NO_DIAGS;
}
