# Sequences (SFC / Grafcet) — design brief

Status: **draft for discussion** · Phase 5 candidate

Control strategies are designed in two ways:

* **Continuous** — function blocks wired together (FBD / CFC). This is what the
  app does today: *strategies*.
* **Sequential** — steps and transitions (SFC per IEC 61131-3, Grafcet per
  IEC 60848): start-up / shut-down, filling, dosing, CIP, batch phases (ISA-88).

This brief adds **sequences** as a second kind of diagram in the same project:
same hierarchy, libraries, validation, versioning, visual diff and exports. Like
strategies, sequences stay **system independent** — a functional design that the
integrator implements in the target DCS.

---

## 1. Concepts

| Element | Meaning | Drawing |
|---|---|---|
| **Step** | A state of the sequence. Active or inactive. | Box with step name (`S10`) and description |
| **Initial step** | Active after start / reset. Exactly one per sequence. | Double box |
| **Transition** | Condition to leave the active step(s) and activate the next one(s). | Horizontal bar between steps, condition text to the right |
| **Action** | What happens while a step is active. Has a qualifier. | Box right of the step, qualifier in a left column |
| **Alternative branch** | One of several paths, chosen by the first true transition (OR). | Single horizontal line |
| **Parallel branch** | Several paths run simultaneously; joined when all are done (AND). | Double horizontal lines |
| **Jump** | Continue at another step (loops, return to idle). | Arrow with the target step name |
| **Step monitoring** | Expected min / max time in a step, alarm on timeout. | Small time note at the step |

Action qualifiers (IEC 61131-3 subset): `N` while active, `S` set (stored),
`R` reset, `P` pulse on entry (`P1`) / exit (`P0`), `D` delayed, `L` time limited.

Every step exposes signals other diagrams can read: `S10.X` (active) and
`S10.T` (time in step). The sequence as a whole exposes `RUNNING`, `DONE`,
`ALARM` and the active step number `STEP`.

## 2. Connection to strategies

Sequences and strategies talk through the same addressing as today
(`STRATEGY:BLOCK.PORT`):

* **Conditions read signals** from strategies:
  `LIC100:LT100.PV >= 3.5 and not P101:HEALTHY.OUT`.
* **Actions write commands** to block inputs:
  `S P101:P101.START`, `N FIC101:FIC101.SP_EXT := 40`.
* **Strategies read the sequence**: `FILL_T100:S20.X -> P101.START` — shown on
  both sides as cross-reference connectors, like signals between strategies today.

In early design an action or condition may be **plain text only**
(“Open inlet valve”, “Tank full”). Validation shows such items as *not linked*
(info), so a sequence can start as a description and become precise later.

## 3. File format

One sequence = one YAML file next to the strategies of its unit:

```
strategies/ACME/Brno/WaterTreatment/U100/
  FIC101.yaml          strategy
  FILL_T100.seq.yaml   sequence      ← new
  FILL_T100.md         its description (as for strategies)
```

```yaml
format: csd-sequence/1
uid: 6f0c…
sequence: FILL_T100
title: Fill tank T100
description: Fills T100 to the operating level with the feed pump.
scan: 500ms

steps:
  S0:
    initial: true
    description: Idle
  S10:
    description: Open inlet, start pump
    actions:
      - { q: S, set: P101:P101.START }
      - { q: N, set: FIC101:FIC101.SP_EXT, value: 40 }
    time: { max: 10min }
  S20:
    description: Wait for level
    actions:
      - { q: N, text: Keep inlet flow at 40 m3/h }   # descriptive only
  S30:
    description: Stop pump
    actions:
      - { q: R, set: P101:P101.START }

transitions:
  - { from: S0,  to: S10, condition: START_CMD and not LIC100:LAL100.QH }
  - { from: S10, to: S20, condition: P101:P101.RUNNING }
  - { from: S20, to: S30, condition: LIC100:LT100.PV >= 3.5, comment: Operating level }
  - { from: S30, to: S0,  condition: S30.T > 5s }

# Parallel branch: one transition to several steps (fork) / from several (join)
#  - { from: S40, to: [S50, S60], condition: … }
#  - { from: [S55, S65], to: S70, condition: … }

inputs:          # named external commands / signals of the sequence (optional)
  - { name: START_CMD, type: BOOL, description: Operator start }
```

Rules:

* Steps are keyed by name (identity for diff and references). Recommended
  numbering `S0, S10, S20 …` leaves room for inserted steps.
* Transitions are identified by `from → to` (stable for diff).
* `condition` is a small **expression language**: `and or not`, comparisons
  `< <= = <> >= >`, parentheses, numbers with units / durations, `TRUE FALSE`,
  references `STRATEGY:BLOCK.PORT`, `S10.X`, `S10.T`, sequence inputs. It is
  parsed and type-checked (must be BOOL); unknown references are errors.
* `pos` per step only after manual moves (same rule as blocks).
* `x-…` keys are kept for integrations; `format` is versioned and migrated.

## 4. Drawing and layout

Classic vertical SFC: steps top-down, transitions as bars with the condition on
the right, actions in boxes to the right of each step.

* **Auto layout:** layers by longest path from the initial step; alternative and
  parallel branches side by side with single / double lines; backward edges
  (loops, return to idle) are drawn as **jump arrows** with the target name
  instead of long lines (Grafcet convention, keeps sheets readable).
* Long sequences split into **sheets** the same way strategies do, with
  off-sheet connectors.
* The same renderer pipeline (geometry → SVG) is used for the editor, PDF,
  HTML viewer and visual diff.

## 5. Editing

* Palette for sequences: Step, Transition, Alternative branch, Parallel branch,
  Jump. Draw a transition by dragging from a step to a step.
* Inspector: step (name, description, monitoring times, actions table with
  qualifier / target / value / text), transition (condition with
  autocompletion of signals, comment).
* YAML editor with completion of step names, references and qualifiers.
* Insert step between two steps (“split transition”), renumber steps.
* Everything as operations (undo, history, diff) like strategies.

## 6. Validation

* Exactly one initial step; every step reachable; no dead ends without a
  deliberate end step.
* Each transition has a condition (text-only conditions → info "not linked").
* Parallel branches are well formed (every fork is closed by a join).
* References exist and have the right type; written inputs are not also driven
  by a link in the strategy (conflict warning).
* Monitoring times are valid durations; `min <= max`.

## 7. Exports and versions

* **PDF:** per sequence the drawing sheets, a step table (step, description,
  actions, monitoring) and a transition table (from, to, condition, comment),
  plus cross references to strategies.
* **HTML viewer:** same pages; clicking a reference opens the strategy.
* **Visual diff:** steps by name, transitions by `from → to`, actions and
  conditions as field changes.

## 8. Implementation plan

| Step | Content | Size |
|---|---|---|
| S1 · Core | `csd-sequence/1` schema, model, parser, expression language, validation, cross references with strategies, ops | M |
| S2 · Layout & render | SFC layout (layers, branches, jumps), renderer, sheets | M |
| S3 · Editor | canvas tools, inspector, completion, palette | M–L |
| S4 · Exports & diff | PDF sections, viewer pages, visual diff | M |
| S5 · Later | sequence test mode (token player), ISA-88 phase states (Running / Holding / Stopping / Aborting), sub-sequences (macro steps) | L |

## 9. Open questions

1. **File naming:** `NAME.seq.yaml` next to strategies (proposed), or a separate
   folder per unit?
2. **Conditions:** text expressions only (proposed), or also small FBD networks
   for complex conditions (CFC-style "transition networks")?
3. **Actions:** commands to block inputs + free text (proposed); also calling
   other sequences (sub-sequences) from the start, or later?
4. **ISA-88 phase states** (hold / restart / stop / abort paths): needed in the
   first version, or later?
5. **Step numbering:** enforce a convention (`S` + multiples of 10), or free names?
