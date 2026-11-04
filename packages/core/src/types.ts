// ---------------------------------------------------------------------------
// Control Strategy Studio core data model.
//
// The project is a set of files (YAML, Markdown, assets). YAML is the source of
// truth; everything below is the *parsed view* of those files. Nothing here
// depends on a browser, React or Node — the core runs anywhere.
// ---------------------------------------------------------------------------

/** File content: text for YAML/Markdown, bytes for assets (images…). */
export type FileContent = string | Uint8Array;
/** A project is a flat map of POSIX paths (relative to project root) to content. */
export type Files = Readonly<Record<string, FileContent>>;

/** Free-form extension data (`x-…` keys). Preserved by the core, never interpreted. */
export type Ext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export interface Diag {
  severity: Severity;
  /** Stable machine-readable code, e.g. `unknown-port`. Safe for integrations. */
  code: string;
  message: string;
  file?: string;
  /** 1-based line in `file`, when known. */
  line?: number;
  block?: string;
  link?: number;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface PortDef {
  name: string;
  /** BOOL, INT, DINT, REAL, TIME, STRING, ANY, ANY_NUM, ENUM or a custom name. */
  type: string;
  description?: string;
  default?: unknown;
  unit?: string;
  /** Allowed values for ENUM. */
  values?: string[];
  /** Pin on the drawing: `always` (default) or only when `connected` (linked or set to a constant). */
  visibility?: 'always' | 'connected';
  ext: Ext;
}

export type BlockKind = 'basic' | 'composite';

export interface BlockTypeDef {
  file: string;
  /** Library folder name, e.g. `std`. */
  library: string;
  uid?: string;
  type: string;
  version: string;
  category: string;
  description: string;
  color?: string;
  kind: BlockKind;
  inputs: PortDef[];
  outputs: PortDef[];
  params: PortDef[];
  implementation?: { language?: string; source?: string };
  /** Inner diagram of a composite block. */
  diagram?: Diagram;
  ext: Ext;
}

export interface LibraryDef {
  /** Folder under `library/`. */
  folder: string;
  file: string;
  uid?: string;
  name: string;
  version: string;
  description?: string;
  types: BlockTypeDef[];
  ext: Ext;
}

// ---------------------------------------------------------------------------
// Diagram — shared by strategies and composite block internals
// ---------------------------------------------------------------------------

export interface SheetDef {
  id: number;
  title?: string;
}

export interface BlockInst {
  id: string;
  /** Type reference as written: `PID`, `PID@1.0.0`, `acme/PID@1.0.0`. */
  typeRef: string;
  /** Resolved definition (undefined when the type is unknown). */
  def?: BlockTypeDef;
  description?: string;
  doc?: string;
  comment?: string;
  scan?: string;
  order?: number;
  sheet: number;
  params: Record<string, unknown>;
  /** Only present when the block was positioned by hand. */
  pos?: [number, number];
  ext: Ext;
}

export interface Endpoint {
  /** Set when the endpoint lives in another strategy (`LIC100:LIC100.MV`). */
  strategy?: string;
  /** Block id. In composite internals `in` / `out` address the interface. */
  block: string;
  port: string;
}

export interface LinkInst {
  /** Index in the YAML `links` list (stable address for operations). */
  index: number;
  from: Endpoint;
  to: Endpoint;
  comment?: string;
  /** Signal name drawn along the line. */
  label?: string;
  /** Signal category (styled by the project's `signal_categories`). */
  category?: string;
  ext: Ext;
}

export interface NoteInst {
  index: number;
  text: string;
  sheet: number;
  pos?: [number, number];
  width?: number;
}

export interface Diagram {
  sheets: SheetDef[];
  blocks: BlockInst[];
  links: LinkInst[];
  notes: NoteInst[];
}

// ---------------------------------------------------------------------------
// Strategy & project
// ---------------------------------------------------------------------------

export interface Strategy extends Diagram {
  file: string;
  uid?: string;
  name: string;
  title?: string;
  description?: string;
  revision?: string;
  author?: string;
  scan?: string;
  /** Path of the companion Markdown function description, if present. */
  docFile?: string;
  /** Folder path relative to `strategies/` ('' = root). */
  folder: string;
  ext: Ext;
}

export interface TitleBlock {
  logo?: string;
  drawn?: string;
  checked?: string;
  approved?: string;
}

export interface SignalCategory {
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  width?: number;
  description?: string;
}

export interface ProjectMeta {
  uid?: string;
  name: string;
  description?: string;
  author?: string;
  levels: string[];
  titleBlock: TitleBlock;
  /** Line styles for link categories, e.g. interlock / tracking. */
  signalCategories: Record<string, SignalCategory>;
  ext: Ext;
}

export interface FolderNode {
  /** Path relative to `strategies/` ('' = root). */
  path: string;
  name: string;
  depth: number;
  /** Hierarchy level name (from `levels`), if defined for this depth. */
  level?: string;
  readme?: string;
  folders: FolderNode[];
  strategies: string[]; // strategy files
}

export type Selection =
  | { kind: 'block'; id: string }
  /** Several blocks (multi-selection). Always 2+ ids; a single block uses kind 'block'. */
  | { kind: 'blocks'; ids: string[] }
  | { kind: 'link'; index: number }
  | { kind: 'note'; index: number }
  | null;
