<img src="brand/logo-wordmark.svg" alt="Control Strategy Studio" height="64">

# Control Strategy Studio

Tool for writing **control strategy diagrams**: system-independent, CFC-like
function block diagrams that can be edited as text (YAML) or graphically, versioned
with git and shared with plants as PDF.

Design document: see the "Control Strategy Studio – návrh" artifact (revision C).

## Status

| Phase | Content | State |
|---|---|---|
| 1 · Core | format & schemas, model, libraries, composite blocks, validation, operations, layout, SVG render, std library, tests | **done** |
| 2 · Editor | web app: tree, palette, canvas with sheets, properties, YAML editor, undo/redo, browser autosave, ZIP | **done** |
| 3 · Hand-over | PDF (Markdown docs, charts) | next |
| 4 · Versions | git history (isomorphic-git), revisions, diff, library management | planned |

## Repository layout

```
apps/
  web/      @csd/web    – editor (React); builds to ONE offline HTML file: npm run build → apps/web/dist/index.html
packages/
  core/     @csd/core   – format, model, validation, operations, layout (no UI, no browser APIs)
  render/   @csd/render – SVG renderer for laid-out sheets (screen, PDF, CLI)
schema/     JSON Schemas of all file kinds (generated, the published format contract)
scripts/    render-demo.ts, export-schemas.ts
```

## Project format (short)

```
project.yaml                      name, hierarchy levels, title block
README.md                         project introduction
library/<lib>/library.yaml        a library = a self-contained, copyable folder
library/<lib>/<TYPE>@<ver>.yaml   one version of one block type (basic or composite)
strategies/<hierarchy…>/<NAME>.yaml   strategy (sheets, blocks, links, notes)
strategies/<hierarchy…>/<NAME>.md     function description (Markdown)
strategies/<hierarchy…>/README.md     description of a hierarchy level
assets/                           images, logo
```

Key rules: links are `BLOCK.PORT -> BLOCK.PORT`, the source may live in another
strategy (`LIC100:LIC100.MV`); `pos` is stored only for hand-placed blocks; any
`x-…` key is preserved for integrations; every file carries `format: csd-<kind>/<n>`
and old formats are migrated on load.

## Architecture rules

* All changes go through `applyOp(files, op)` (`packages/core/src/ops.ts`). Ops edit
  the YAML syntax tree, so comments and formatting survive, and return the previous
  content for undo.
* `@csd/core` must not import UI code or browser/Node APIs — it has to run in the
  browser, a CLI and a server.
* Diagnostics have stable `code`s; integrations may rely on them.

## Commands

```bash
npm install
npm test            # vitest
npm run typecheck
npm run demo        # renders the demo project to out/index.html
npm run schemas     # regenerates schema/*.json
```
