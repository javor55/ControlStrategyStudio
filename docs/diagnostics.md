# Diagnostic codes

Every problem the validator reports carries a stable `code`. Integrations
(CI checks, exports, other tools) may rely on these codes; the message text may
change. Severity: **error** — the file cannot be used as intended;
**warning** — probably a mistake; **info** — a hint (e.g. an action described in
words only).

A test (`packages/core/test/diagnostics-doc.test.ts`) checks that every code the
core can report is listed here.

## Files and format

| Code | Severity | Meaning |
|---|---|---|
| `yaml-syntax` | error | The file is not valid YAML. |
| `bad-format` | warning | `format:` is not a recognised `csd-<kind>/<version>` tag. |
| `wrong-format-kind` | error | The format tag names another kind of file (e.g. a sequence tag in a strategy file). |
| `format-too-new` | error | The file was written by a newer version of the tool. |
| `no-migration` | error | No migration exists from the file's format version. |
| `missing-project-file` | error | `project.yaml` is missing. |
| `missing-key` | error | A required key is missing (schema). |
| `unknown-key` | warning | A key the format does not know (use `x-…` for own data). |
| `bad-type` | error | A value has the wrong YAML type (schema). |
| `schema` | error | Other schema violation. |
| `bad-name` | error | Invalid name of a strategy, sequence, block, step or port. |
| `reserved-id` | error | The block name is reserved (`in`, `out`). |
| `reserved-name` | error | The name is reserved (strategy `README`, step `SEQ`). |
| `name-mismatch` | warning | The name inside the file differs from the file name. |
| `file-name-mismatch` | warning | A block type file is not named `<TYPE>@<version>.yaml`. |
| `duplicate-strategy` | error | Two strategies / sequences share a name (they share one name space). |
| `unknown-category` | warning | A link uses a line category that is not defined. |

## Libraries and block types

| Code | Severity | Meaning |
|---|---|---|
| `missing-type` | error | A block has no `type`. |
| `bad-type-ref` | error | Malformed type reference (expected `TYPE`, `TYPE@1.0.0` or `lib/TYPE`). |
| `unknown-type` | error | The block type does not exist in any library. |
| `unknown-version` | error | The requested version of the type does not exist. |
| `ambiguous-type` | error | The type name exists in several libraries — write `lib/TYPE`. |
| `duplicate-type` | error | The same type and version is defined twice. |
| `duplicate-port` | error | A type defines a port or parameter name twice. |
| `recursive-composite` | error | A composite block contains itself (directly or indirectly). |
| `unconnected-output` | warning | An output of a composite type is not driven inside its diagram. |
| `param-ref-outside-composite` | error | `$PARAM` is used outside a composite type. |
| `unknown-param-ref` | warning | `$PARAM` refers to a parameter the composite type does not have. |
| `ext-in-composite` | error | A composite's inner diagram references another strategy. |

## Continuous strategies (function block diagrams)

| Code | Severity | Meaning |
|---|---|---|
| `bad-link` | error | A link is not of the form `BLOCK.PORT -> BLOCK.PORT` (a planned link needs one end `BLOCK.PORT` in this diagram). |
| `unknown-strategy` | error | A link, condition or action names a strategy / sequence that does not exist. |
| `unknown-block` | error | The block does not exist. |
| `unknown-port` | error | The block type has no such port. |
| `wrong-direction` | error | An input used as a source or an output used as a target. |
| `ext-target` | error | A link writes into another strategy (links only pull signals). |
| `multiple-drivers` | error | An input is driven by more than one link. |
| `type-mismatch` | warning | Signal types of the two ends do not match (e.g. REAL into BOOL). |
| `linked-and-constant` | warning | An input is linked and also has a constant; the link wins. |
| `unknown-param` | warning | A parameter the block type does not define. |
| `bad-value` | warning | A constant / parameter value does not fit its type or range. |
| `bad-scan` | warning | `scan` is not a duration (e.g. `100ms`, `1s`). |
| `missing-order` | warning | A block has no execution order while others have one. |
| `duplicate-order` | warning | Two blocks share an execution order. |
| `duplicate-sheet` | error | A sheet id is defined twice (strategies and sequences). |
| `unknown-sheet` | warning | A block, step or note is placed on a sheet that is not defined. |
| `planned-link` | info | A planned connection (`planned: true`): the other end is not drawn yet. |
| `planned-resolves` | info | A planned source written as `STRATEGY:BLOCK.PORT` exists now — remove `planned: true` to make it a real link. |

## Sequence strategies (SFC)

| Code | Severity | Meaning |
|---|---|---|
| `no-steps` | warning | The sequence has no steps yet. |
| `no-initial-step` | error | No step is marked `initial: true`. |
| `multiple-initial-steps` | error | More than one initial step. |
| `unknown-step` | error | A transition names a step that does not exist. |
| `bad-transition` | error | A transition lacks `from` or `to`. |
| `duplicate-transition` | warning | Two transitions with the same `from` and `to`. |
| `missing-condition` | warning | A transition has no condition yet. |
| `bad-condition` | error | The condition cannot be parsed, names an unknown signal or is not BOOL. |
| `condition-not-linked` | info | The condition is described in words only. |
| `bad-action-target` | error | An action's `set` is not `STRATEGY:BLOCK.PORT`. |
| `empty-action` | warning | An action has neither a target (`set`) nor a description (`text`). |
| `action-not-linked` | info | An action is described in words only. |
| `action-target-linked` | warning | An action writes an input that is also driven by a link. |
| `missing-value` | warning | An action writes a non-BOOL input without a value. |
| `missing-time` | warning | Qualifier `D` / `L` without a time. |
| `multiple-writers` | warning | Several sequences write the same input — make sure they never run at the same time. |
| `unreachable-step` | warning | The step cannot be reached from the initial step. |
| `dead-end-step` | info | The step has no outgoing transition (end of the sequence). |
| `duplicate-sequencer` | error | Two sequencers share an id. |
| `unknown-sequencer` | error | A step names a sequencer that is not listed in `sequencers`. |
| `cross-sequencer-transition` | error | A transition connects steps of different sequencers; each sequencer is its own chain. |
| `missing-start-condition` | warning | A sequence has several sequencers and one of them has no start condition. |
| `duplicate-priority` | warning | Several sequencers share a priority, so it is unclear which runs when both may start. |
| `unclosed-parallel` | warning | A parallel branch is not closed by one join of exactly its branches. |
| `unmatched-join` | error | A join waits for steps that are not started together by one parallel branch (e.g. two alternative branches) — it would wait for ever. |
