# Roadmap and ideas

What could come next, roughly by value for designing and handing over control
strategies. Sizes: **S** small (≤ 1 day), **M** medium, **L** large.

## Done recently

- [x] **Sequences (SFC / Grafcet)** — editor, condition language, validation,
      cross references with strategies, PDF / HTML / JSON exports, history and
      visual diff. Design: [design/sequences.md](design/sequences.md).

## Sequences — follow-ups

- [ ] ISA-88 phase states (hold / restart / stop / abort paths). **M–L**
- [ ] Sub-sequences (macro steps / calling another sequence). **M**
- [x] Copy / paste of steps (clipboard fragments as for blocks). **S**
- [x] Visual diff: ghosts of removed steps and transitions on the canvas. **S**
- [ ] History summary should mention changes of the sequence description (.md). **S**
- [ ] Sequence test mode (token player) — see Verification below. **L**

## Ideas

### Engineering data

- [ ] **Parameter tables / bulk editing** — spreadsheet view of all blocks of a
      type across the project (e.g. every PID with GAIN / TI / TD / ranges),
      filter by hierarchy, edit in cells, CSV / Excel export and import. **S–M**
- [ ] **IO list and tag list** — generated list of all AI / AO / DI / DO
      (channel, range, unit, description, strategy) as a view, PDF section and
      Excel export; import a tag list from Excel to create I/O blocks and draft
      strategies. **M**
- [ ] **Engineering checks (lint rules)** — configurable per project: tag
      naming convention (ISA-5.1 or own regex per block type), unconnected
      required inputs, link from a slower to a faster scan, unit mismatch along
      a link (m3/h into %), missing description / order. **S–M**
- [ ] **Cause & Effect matrix** — interlock matrix generated from INTLK / AND /
      OR logic (or written by hand and linked to the diagrams); PDF section. **M–L**
- [ ] **Alarm list** — alarm limits, priorities and delays collected from AI /
      LIM_ALM blocks into a table and export. **S–M**

### Review and collaboration

- [ ] **Review comments** — comment threads pinned to blocks, links and
      strategies with author and open / resolved state; list of open comments;
      included in exports on request. **M**
- [ ] **Approval** — "checked / approved by" per revision, written into the
      PDF title block. **S**
- [ ] **Git server sync** — push / pull to GitHub / GitLab from the app
      (isomorphic-git; needs an access token and a CORS proxy). **M**
- [ ] **Local folder** — open / save a project folder directly (File System
      Access API, Chrome / Edge), so ordinary git tools can be used alongside. **M**

### Verification

- [ ] **Test mode (logic simulation)** — toggle inputs on the diagram and watch
      outputs and interlocks; behaviour models for the std library (logic,
      timers, comparators, simple PID). Later also a token player for
      sequences. **L**

### Integration

- [ ] **Dialects / export to DCS** — map abstract blocks to blocks of a target
      system (PCS 7 APL, DeltaV, TIA …) at export time. Not just renaming:
      different IO, meaning and extra parameters per system. Needs its own
      design. **L**
- [ ] **CLI** — `validate`, `pdf`, `html`, `json` for CI pipelines (the core
      already runs in Node; the PDF writer needs a DOM or a headless browser). **M**
- [ ] **Import JSON / TOML** — the counterpart of the data export. **S**

## Small improvements

- [ ] Minimap and "find block" on the canvas. **S**
- [ ] Align / distribute selected blocks. **S**
- [ ] Render ```mermaid blocks in documentation (editor, viewer, PDF). **M**
- [ ] Expand / collapse block parameters in the HTML viewer (view only). **S**
- [ ] The line drawn while dragging a new wire should use the project line style. **S**
- [ ] PDF: block header text (e.g. inherited scan "(500ms)") can overflow by a
      few pixels because PDF font metrics differ from the screen. **S**
- [ ] Rubber-band selection should include notes. **S**
- [ ] Reconnecting a link keeps label / category / comment but drops `x-…` keys. **S**
- [ ] "Take strategy from this version" should also take its `.md` description. **S**
- [ ] Visual diff: show ghosts of removed items that were on another sheet. **S**
- [ ] Unit tests for UI helpers (vitest currently covers `packages/*` only). **S**
- [ ] Bundle size: the editor is ~3.5 MB as one file (fonts, PDF writer, viewer
      template); load the PDF writer lazily where the build allows. **S–M**
