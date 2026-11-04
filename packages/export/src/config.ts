// Export configuration — what goes into a PDF or a read-only HTML export.
import type { DisplayOptions } from '@csd/core';

export type ExportFormat = 'pdf' | 'html';

export interface ExportSections {
  /** Title page with project data and problems summary. */
  cover: boolean;
  /** Table of contents (PDF). */
  contents: boolean;
  /** Project README.md. */
  projectReadme: boolean;
  /** README.md of hierarchy folders (area, unit … descriptions). */
  folderReadmes: boolean;
  /** Strategy function description (<NAME>.md) and the purpose of each block. */
  functionDescription: boolean;
  /** Diagram sheets. */
  diagrams: boolean;
  /** Parameter sheet of every block. */
  blockSettings: boolean;
  /** Links, signals from other strategies and "used by". */
  links: boolean;
  /** Interfaces (and composite diagrams) of the block types used. */
  library: boolean;
  /** Implementation source code in the library appendix. */
  librarySource: boolean;
}

export interface ExportDisplay extends Pick<DisplayOptions, 'params' | 'comments'> {
  ports: 'auto' | 'all' | 'used';
  /** Execution order badges. */
  order: boolean;
  /** z⁻¹ marks on previous-cycle links. */
  feedback: boolean;
  /** Signal names and comments along links. */
  labels: boolean;
  /** Colours / line styles of signal categories. */
  categories: boolean;
}

export interface ExportConfig {
  format: ExportFormat;
  /** Strategy files to include. Empty = all strategies of the project. */
  strategies: string[];
  paper: 'A4' | 'A3';
  sections: ExportSections;
  /** Block settings: only values set in the strategy, or every parameter with its default. */
  parameters: 'set' | 'all';
  display: ExportDisplay;
  /** Title block overrides (default: project data, today). */
  titleBlock: { revision?: string; date?: string; author?: string };
}

export function defaultExportConfig(format: ExportFormat = 'pdf'): ExportConfig {
  return {
    format,
    strategies: [],
    paper: 'A3',
    sections: {
      cover: true,
      contents: true,
      projectReadme: true,
      folderReadmes: true,
      functionDescription: true,
      diagrams: true,
      blockSettings: true,
      links: true,
      library: format === 'html',
      librarySource: false,
    },
    parameters: 'set',
    display: { ports: 'auto', params: true, comments: true, order: true, feedback: true, labels: true, categories: true },
    titleBlock: {},
  };
}

/** Merges a stored (possibly older / partial) config over the defaults. */
export function normalizeExportConfig(raw: unknown, format: ExportFormat): ExportConfig {
  const d = defaultExportConfig(format);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ExportConfig>;
  return {
    format,
    strategies: Array.isArray(r.strategies) ? r.strategies.filter((s) => typeof s === 'string') : d.strategies,
    paper: r.paper === 'A4' || r.paper === 'A3' ? r.paper : d.paper,
    sections: { ...d.sections, ...(r.sections ?? {}) },
    parameters: r.parameters === 'all' ? 'all' : 'set',
    display: { ...d.display, ...(r.display ?? {}) },
    titleBlock: { ...(r.titleBlock ?? {}) },
  };
}

/** Layout display options for an export. */
export function layoutDisplay(c: ExportConfig): DisplayOptions {
  return { ports: c.display.ports, params: c.display.params, comments: c.display.comments };
}
