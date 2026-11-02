// Project file layout conventions. Every file's role is derived from its path,
// so any storage (browser, ZIP, folder, git, backend) can hold a project as-is.
//
//   project.yaml                        project metadata
//   README.md                           project introduction (Markdown)
//   library/<lib>/library.yaml          library header
//   library/<lib>/<Type>@<ver>.yaml     one version of one block type
//   strategies/<folders…>/<Name>.yaml   strategy
//   strategies/<folders…>/<Name>.md     strategy function description
//   strategies/<folders…>/README.md     description of a hierarchy level
//   assets/…                            images, logo, attachments
//
// Anything else is kept untouched (forward compatibility).

export const PROJECT_FILE = 'project.yaml';
export const LIB_DIR = 'library/';
export const STRATEGY_DIR = 'strategies/';
export const ASSET_DIR = 'assets/';

export type FileRole =
  | { kind: 'project' }
  | { kind: 'readme'; folder: string | null } // null = project root
  | { kind: 'library'; lib: string }
  | { kind: 'blocktype'; lib: string }
  | { kind: 'strategy'; folder: string; name: string }
  | { kind: 'strategy-doc'; folder: string; name: string }
  | { kind: 'asset' }
  | { kind: 'other' };

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts.filter((s) => s !== '').join('/');
}

export function classify(path: string): FileRole {
  if (path === PROJECT_FILE) return { kind: 'project' };
  if (path === 'README.md') return { kind: 'readme', folder: null };
  if (path.startsWith(ASSET_DIR)) return { kind: 'asset' };
  if (path.startsWith(LIB_DIR)) {
    const rest = path.slice(LIB_DIR.length).split('/');
    if (rest.length === 2 && rest[1].endsWith('.yaml')) {
      return rest[1] === 'library.yaml' ? { kind: 'library', lib: rest[0] } : { kind: 'blocktype', lib: rest[0] };
    }
    return { kind: 'other' };
  }
  if (path.startsWith(STRATEGY_DIR)) {
    const rel = path.slice(STRATEGY_DIR.length);
    const folder = dirname(rel);
    const file = basename(rel);
    if (file === 'README.md') return { kind: 'readme', folder };
    if (file.endsWith('.yaml')) return { kind: 'strategy', folder, name: stem(file) };
    if (file.endsWith('.md')) return { kind: 'strategy-doc', folder, name: stem(file) };
  }
  return { kind: 'other' };
}

export function strategyFile(folder: string, name: string): string {
  return joinPath('strategies', folder, `${name}.yaml`);
}

export function strategyDocFile(strategyPath: string): string {
  return strategyPath.replace(/\.yaml$/, '.md');
}

export function folderReadme(folder: string): string {
  return joinPath('strategies', folder, 'README.md');
}

export function libraryFile(lib: string): string {
  return `library/${lib}/library.yaml`;
}

export function blockTypeFile(lib: string, type: string, version: string): string {
  return `library/${lib}/${type}@${version}.yaml`;
}
