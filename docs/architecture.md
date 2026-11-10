# Architecture

How the code is organised and the rules that keep it consistent. For building and
running see the [README](../README.md#development).

## Overview

```
                 ┌──────────────────────────── apps/web (React editor) ───────────────────────────┐
  user ───────►  │ canvas · inspector · text editor · tree · history · export dialog · settings   │
                 │                    │ Op                                                        │
                 │                    ▼                                                           │
                 │  store (state/store.ts) ── applyOp ──► files (YAML text) ──► loadProject ──►   │
                 │        ▲                                                       ProjectModel   │
                 │        └──────────────── render / validate / layout ◄──────────────┘          │
                 │  session.ts: browser storage (IndexedDB) · ZIP · folder on disk · git (vcs)    │
                 └────────────────────────────────────────────────────────────────────────────────┘
packages/core    format, model, validation, ops, layout, router, SFC     (no UI, no browser API)
packages/render  SVG of diagrams and sequences                            (screen, PDF, HTML)
packages/export  export plan, PDF writer, viewer data, JSON / TOML, charts
packages/vcs     git repository in memory (isomorphic-git)
apps/viewer      read-only interactive HTML, built once and embedded in the editor
```

The **files are the model**. The editor holds the project as a map
`path → text`; every view is derived from it by `loadProject` (parse, resolve
libraries, validate). Nothing on screen has state of its own that is not in a file,
except view preferences (zoom, open panels).

## Packages

### `@csd/core` (`packages/core/src`)

| Module | Responsibility |
|---|---|
| `format.ts`, `schema.ts` | `format:` tags, migrations, JSON Schemas (also exported to `schema/`) |
| `project.ts` | `loadProject(files)` → `ProjectModel`: project settings, hierarchy, cross references, project-wide checks |
| `library.ts`, `stdlib.ts` | libraries, block types, versions, the standard library |
| `diagram.ts` | parse continuous strategies (blocks, links, planned links, notes, sheets) |
| `sequence.ts`, `expr.ts`, `signals.ts` | sequences, sequencers, the condition language, signal lookup |
| `validate.ts` | diagnostics with stable codes ([diagnostics.md](diagnostics.md)) |
| `ops.ts` | all edit operations (`applyOp`) |
| `layout.ts`, `router.ts` | automatic layout of function block diagrams, wire routing, scan bands |
| `sfclayout.ts`, `sfcedit.ts` | layout of sequences, insertion of steps / branches |
| `fragment.ts` | clipboard fragments (copy / paste as YAML) |
| `diff.ts` | semantic diff of two project versions (for history and visual compare) |
| `yamlutil.ts`, `paths.ts`, `uid.ts` | YAML AST helpers, project paths, identities |

The core must not import React or browser / Node APIs; it runs in the editor, in
tests and in scripts alike.

### `@csd/render`

Turns a laid-out diagram or sequence into SVG. The same renderer draws the canvas,
the PDF pages and the HTML viewer, so the three always look the same. Styles come
from the project's drawing settings (`lineStrokeFor`, line categories).

### `@csd/export`

`plan.ts` decides what goes into an export (strategies, sections, order);
`pdf/` writes the PDF (vector, embedded fonts); `viewer.ts` / `data.ts` produce the
data of the interactive HTML; `chart.ts` draws charts of Markdown documents;
JSON / TOML are plain data dumps of the model.

### `@csd/vcs`

A git repository in memory (isomorphic-git over a small in-memory file system):
commit, log, tags (revisions), branches, files at a commit. It is serialised into
browser storage, into the ZIP and into the folder's `.git`, so a project folder is
a normal git repository.

### `apps/web`

| Folder | Content |
|---|---|
| `state/` | `store.ts` (editor state, undo / redo, selection, toasts), `session.ts` (open / save, browser storage, ZIP, folder sync, git), `folder.ts` (File System Access API), `selectors.ts` |
| `canvas/` | FBD canvas, SFC canvas, chrome (toolbars, sheet tabs), quick insert, minimap, keyboard, help |
| `inspector/` | right panel per selected item |
| `editor/` | CodeMirror text editor with completion, hover and problem markers |
| `project/` | project tree, palette, problems bar, examples |
| `history/` | version menu, commit dialog, history drawer, text and visual diff |
| `export/`, `settings/`, `views/`, `ui/` | dialogs, document / type / asset views, shared UI kit (menus, dialogs, keys) |

The build is a single self-contained `index.html` (also offered as
`control-strategy-studio.html` for offline use).

## Rules

1. **All changes are operations.** Canvas, inspector, text editor and scripts
   produce `Op` objects applied by `applyOp(files, op)`. Ops edit the YAML syntax
   tree, so formatting and `#` comments survive, and return the previous content for
   undo (`restore` op). An op that cannot apply throws `OpError` with a `code`.
2. **One validator.** Problems are computed once from the model and shown everywhere
   (problems bar, inspector, canvas, text markers, exports) with the same code.
3. **Layout is derived.** Only positions moved by hand are stored (`pos`); the rest is
   laid out on every load. The wire router guarantees that lines go around blocks
   and do not overlap each other.
4. **Stable identities.** Projects, strategies, sequences and block types carry a
   `uid`; diagnostic codes and op error codes are part of the public interface.
5. **Unknown data is kept.** `x-…` keys and unknown structure are never dropped by an
   edit.
6. **The core stays headless.** Anything that needs the DOM lives in `apps/` or in the
   PDF writer.

## Tests

* `npm test` — vitest over `packages/*/test`: format, validation, ops (including
  comment preservation), layout and routing invariants, sequences, diff, exports.
* `packages/core/test/diagnostics-doc.test.ts` checks that every diagnostic code is
  documented in [diagnostics.md](diagnostics.md).
* `npm run typecheck` checks all packages, the viewer, the editor and the scripts.
* CI (`.github/workflows/pages.yml`) runs type checks and tests on every push to
  `main`, builds the app and deploys it to GitHub Pages.

## Adding things

* **A new edit** — add an `Op` variant and its case in `ops.ts`, with a test; call it
  from the UI through the store (`dispatch`), never by editing text directly.
* **A new diagnostic** — report it with a new `code` in the validator and add a row
  to `docs/diagnostics.md` (the test fails otherwise).
* **A new file key** — extend the parser, the JSON Schema in `schema.ts`
  (`npm run schemas`), the file format doc and, if it changes meaning, add a format
  migration.
* **A new block type in `std`** — `stdlib.ts`; describe ports and parameters, they are
  the documentation users see in hover help and exports.
