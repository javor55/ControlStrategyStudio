<p align="center">
  <img src="brand/logo-wordmark.svg" alt="Control Strategy Studio" height="72">
</p>

<p align="center">
  <b>Write control strategies once — share them with every plant, whatever DCS it runs.</b><br>
  CFC-style function block diagrams you can edit as a drawing <i>or</i> as text, version with git and hand over as PDF.
</p>

<p align="center">
  <a href="https://javor55.github.io/ControlStrategyStudio/"><b>Open the app</b></a> ·
  <a href="https://javor55.github.io/ControlStrategyStudio/control-strategy-studio.html">Download for offline use</a> ·
  <a href="docs/user-guide.md">User guide</a> ·
  <a href="docs/file-format.md">File format</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Control Strategy Studio: function block diagram of strategy FIC211 with the block inspector" width="900">
</p>

---

## Why

* **Abstract blocks** — AI, PID, interlock … defined only by their interface (inputs,
  outputs, parameters). No mapping to a vendor; the integrator implements it in the
  plant's DCS.
* **Text and drawing are the same thing** — every strategy is a readable YAML file.
  Edit it on the canvas, in the text editor, or side by side; both stay in sync,
  including your `#` comments.
* **Made for review and hand-over** — function descriptions in Markdown, revisions,
  title block, configurable PDF export and an interactive read-only HTML export.

## Features

| | |
|---|---|
| **Canvas** | CFC-like blocks with ports, constants and parameters · draw and reconnect links port to port; lines are routed around blocks and never overlap · several sheets per strategy with off-sheet connectors · links to other strategies with “used by” tags · **planned links** for signals whose other side is not drawn yet · automatic layout, positions stored only for blocks you move · execution order (auto order) · find, minimap, align / distribute, notes · optional **scan time bands** (arrange blocks by scan and show 100 ms / 500 ms / 1 s columns) |
| **Text** | YAML editor with syntax check, problem markers, context-aware completion and hover help · selection follows between text and drawing · Diagram / Split / Text modes |
| **Blocks** | Standard library `std` (40 blocks: I/O, logic, timers, comparators, math, selectors, filters, PID, ratio, split range, motor, valve, interlock) · your own libraries as plain folders · versioned block types · composite blocks with an inner diagram · graphical block type editor |
| **Two strategy types** | **Continuous strategies** (function block diagrams, `NAME.yaml`) and **sequence strategies** (SFC / Grafcet, `NAME.seq.yaml`) — both editable as drawing or text; sequences read and write signals of continuous strategies, and strategies can read sequence states (e.g. `FILL_T100:S20.X`, `FILL_T100:SEQ.RUNNING`); a sequence can hold several **sequencers** with start conditions and priorities (e.g. the ISA-88 states Running / Holding / Aborting) |
| **Line categories** | one default line style plus your own categories (interlock, alarm, tracking …) with colour, line style and width — one table in Settings → Drawing style |
| **Project** | free folder hierarchy; optional level names (none, ISA-95, ISA-88 or your own — only labels, never enforced) · Markdown documentation with images and charts · validation with clear messages (unknown ports, type mismatch, double drivers, wrong references …) |
| **Versions** | git inside every project: commits with readable summaries, revisions (Rev A, Rev B …) in the title blocks, branches, text diff and **visual compare on the canvas**, restore |
| **Hand-over** | configurable **PDF** (cover, contents, title blocks, function descriptions, drawings, parameter tables, cross references, library appendix, revision history) · **interactive HTML** (one read-only file) · JSON / TOML data |
| **Files** | Runs in the browser, works offline · autosave in the browser · projects travel as ZIP or live in a **folder on disk** next to your git tools · git-friendly text files |

<p align="center">
  <img src="docs/screenshot-sequence.png" alt="Sequence BATCH_T210 with a parallel branch and step actions" width="900"><br>
  <sub>A sequence (SFC) with a parallel branch; actions write inputs of continuous strategies.</sub>
</p>

## Use it

* **Online:** <https://javor55.github.io/ControlStrategyStudio/> — nothing to install.
  Projects are stored in your browser; **Save as ZIP** (`Ctrl+S`, in the project menu
  under the project name) keeps or shares them.
* **A folder on disk** (Chrome / Edge): **Open folder…** or **Save to folder…** in the
  project menu links the project to a folder; every change is written there, with the
  git history in its `.git`, so ordinary git tools (and other editors) work alongside.
  Changes made outside the app are picked up when you switch back to the window.
* **Offline:** download
  [`control-strategy-studio.html`](https://javor55.github.io/ControlStrategyStudio/control-strategy-studio.html)
  and open it by double-click. The whole application is this one file.

The first start opens a small demo project. **Open example** in the project menu offers also
*Dosing & CIP Plant Ostrava* — 13 continuous strategies, 3 sequences (CIP with parallel
branches, batch, start-up), a company library with composite blocks, split range, ratio,
feed-forward, interlocks and documentation with charts. **New project…** starts an
empty one.

The [user guide](docs/user-guide.md) walks through the whole editor.

### Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` `Ctrl+X` `Ctrl+V` | Copy, cut, paste blocks or sequence steps (also between strategies and projects; the clipboard holds YAML) |
| `Ctrl+D` / `Ctrl+A` | Duplicate / select all |
| `Ctrl+F` | Find a block or step (all sheets) and show it |
| `Delete` | Delete selection |
| Arrows | Move selection (with `Shift` by 50 px) |
| Wheel / `Ctrl`+wheel | Scroll / zoom |
| Double-click on paper / `/` | Insert a block or a step |
| Drag from the palette | Sequences: drop onto a step (top = before, bottom = after, middle = beside) or onto a transition to insert a step or a whole branch there — the target is highlighted while dragging |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Sequences: insert a step after / before the selected step |
| `Alt+1` `Alt+2` `Alt+3` | Diagram / Split / Text mode |
| `Ctrl+B` / `Ctrl+Alt+B` | Hide the left / right panel |
| `Ctrl+S` | Save project as ZIP |
| `Ctrl+E` / `Ctrl+,` | Export / settings |
| `Ctrl+Shift+C` / `Ctrl+Shift+H` | Commit / history |
| `?` | All canvas shortcuts |

## Project format

A project is a folder of text files (inside a ZIP when shared):

```
project.yaml                         name, hierarchy levels, title block
README.md                            project introduction
library/
  std/                               a library = a self-contained, copyable folder
    library.yaml
    PID@1.0.0.yaml                   one file per version of a block type
  acme/
    AI_2OO3@1.0.0.yaml               composite block (inner diagram)
strategies/
  ACME/Brno/WaterTreatment/U100/     folders = hierarchy levels
    README.md                        description of the unit
    FIC101.yaml                      strategy
    FIC101.md                        its function description
assets/                              images used in the documentation
```

A strategy:

```yaml
format: csd-strategy/1
strategy: FIC101
title: Inlet water flow control
scan: 500ms

sheets:                       # optional — one sheet by default
  - { id: 1, title: Flow control }

blocks:
  FT101:
    type: AI
    description: Inlet flow transmitter
    order: 10
    params: { PV_HI: 50, UNIT: m3/h }
  FIC101:
    type: PID@1.0.0           # pinned version; "PID" = latest
    order: 20
    params: { GAIN: 0.8, TI: 12s, SP_EXT_ON: true }
    comment: Tuning from loop test during FAT.
  FV101:
    type: AO
    order: 30
    pos: [640, 140]           # only stored after the block was moved by hand

links:
  - FT101.PV -> FIC101.PV
  - from: LIC100:LIC100.MV    # signal from another strategy
    to: FIC101.SP_EXT
    comment: Cascade SP
  - FIC101.MV -> FV101.IN
```

Rules in short:

* Links are `BLOCK.PORT -> BLOCK.PORT`; the source may live in another strategy
  (`STRATEGY:BLOCK.PORT`). The other strategy shows a “used by” tag automatically.
* Not drawn yet? A **planned link** marks where a signal will come from or go to,
  as free text or `STRATEGY:BLOCK.PORT`:
  `{ from: Level control T200, to: FIC101.SP_EXT, planned: true }`. It is drawn as a
  grey dashed arrow; once the named signal exists, one click makes it a real link
  (right-click a port → *Add planned source / destination…*).
* Unconnected inputs can hold constants (`SP_EXT_ON: true`), shown next to the port.
* Any key starting with `x-` is kept untouched — room for data of other systems.
* Every file carries `format: csd-<kind>/<version>`; older formats are migrated on load.
  JSON Schemas of all file kinds are in [`schema/`](schema).

The full reference — project settings, libraries and block types, sequences,
signals — is in [docs/file-format.md](docs/file-format.md).

## Documentation

* [User guide](docs/user-guide.md) — the editor step by step
* [File format](docs/file-format.md) — every file kind with examples
* [Diagnostic codes](docs/diagnostics.md) — all validation messages
* [Sequences — design](docs/design/sequences.md) — SFC concepts, sequencers, ISA-88
* [Architecture](docs/architecture.md) — packages, data flow and rules for contributors
* [Roadmap](docs/ROADMAP.md) — ideas and known gaps

## Development

```bash
npm install
npm run dev         # editor at http://localhost:5173
npm test            # unit tests (vitest)
npm run typecheck
npm run build       # → apps/web/dist/index.html (single offline file)
npm run demo        # renders the demo project to out/index.html
npm run schemas     # regenerates schema/*.json
```

Every push to `main` runs type checks and tests, builds the app and deploys it to
GitHub Pages (`.github/workflows/pages.yml`).

### Repository layout

```
packages/
  core/     @csd/core   – format, model, libraries, validation, operations, layout
                          (no UI, no browser APIs — also runs in Node / on a server)
  render/   @csd/render – SVG renderer shared by screen, PDF and HTML export
  export/   @csd/export – export plan, PDF writer, viewer data, JSON / TOML, charts
  vcs/      @csd/vcs    – git in the project (isomorphic-git, in memory)
apps/
  web/      @csd/web    – the editor (React + CodeMirror)
  viewer/   @csd/viewer – read-only interactive HTML export (embedded in the editor)
brand/      logo
docs/       user guide, file format, architecture, diagnostic codes, design notes, roadmap
schema/     JSON Schemas (generated)
```

### Architecture rules

* **All changes are operations.** Canvas, inspector, text editor and any future API
  produce `Op` objects applied by `applyOp(files, op)` (`packages/core/src/ops.ts`).
  Ops edit the YAML syntax tree, so formatting and comments survive, and return the
  previous content for undo. This is also the unit for future multi-user sync.
* **The core has no UI.** `@csd/core` must not import React or browser/Node APIs.
* **Stable identities.** Projects, strategies and block types carry a `uid`;
  diagnostics carry stable `code`s that integrations may rely on
  ([list](docs/diagnostics.md)); failed operations throw `OpError` with a `code`.

More in [docs/architecture.md](docs/architecture.md).

## Roadmap

| Phase | Content | State |
|---|---|---|
| 1 · Core | format & schemas, libraries, composite blocks, validation, operations, layout, renderer | done |
| 2 · Editor | canvas, inspector, text editor (completion, hover), project tree, palette, settings, autosave, ZIP | done |
| 3 · Hand-over | configurable export: PDF, interactive read-only HTML, JSON / TOML | done |
| 4 · Versions | git in the project: commits, revisions, branches, text and visual diff, restore | done |
| 5 · Sequences | SFC / Grafcet diagrams next to continuous strategies: editor, validation, cross references, exports, diff — [design](docs/design/sequences.md) | done |

More ideas and known gaps: [docs/ROADMAP.md](docs/ROADMAP.md).
