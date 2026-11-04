// Showcase example: a chemical dosing and CIP plant. Larger than the demo and
// meant to show what the format can express: ISA-88 hierarchy, a company
// library with composite and basic custom blocks, cascades, split range,
// ratio and feed-forward control, interlocks, alarms, previous-cycle
// feedback, multi-sheet strategies, cross references, sequences with
// parallel and alternative branches, and Markdown documentation with
// tables, charts and images.
import { stdLibraryFiles } from '../stdlib';
import type { Files } from '../types';

const uid = (n: number) => `c1d05e00-7a3b-4c2e-9f10-${String(n).padStart(12, '0')}`;

const SITE = 'strategies/ACME/Ostrava';
const UTIL = `${SITE}/Utilities`;
const U110 = `${UTIL}/U110`;
const DOS = `${SITE}/Dosing`;
const U210 = `${DOS}/U210`;
const U220 = `${DOS}/U220`;
const CIP = `${SITE}/CIP`;
const U310 = `${CIP}/U310`;

// ---------------------------------------------------------------------------
// Project, README and assets
// ---------------------------------------------------------------------------

const PROJECT = `format: csd-project/1
uid: ${uid(1)}
name: Dosing & CIP Plant Ostrava
description: Process water supply, batch mixing with chemical dosing and clean-in-place (CIP) of the mixing tank
author: ACME Process Engineering
levels:
  - Enterprise
  - Site
  - Area
  - Unit
  - Equipment Module
  - Control Module
title_block:
  drawn: J. Novak
  checked: P. Svoboda
  approved: ""
signal_categories:
  bool: { color: "#2f7d4a", description: Binary signals }
  numeric: { color: "#1f5f8b", description: "Analog values (REAL, INT …)" }
  interlock: { color: "#b3261e", style: dashed, width: 1.6, description: Safety and process interlocks (TRUE = healthy) }
  tracking: { color: "#6b7280", style: dotted, description: "Output tracking, readbacks and bumpless transfer" }
  alarm: { color: "#c2571a", style: dashdot, width: 1.4, description: Alarms to the operator (HMI / beacon) }
drawing:
  feedback: { mark: true, style: dashdot, color: "#7a4fa3" }
  params: show
`;

const README = `# Dosing & CIP Plant Ostrava

Control strategies for the batch mixing plant in Ostrava. Process water from
tank T110 is pumped to the mixing tank T210, where a batch is prepared with
caustic and acid dosing, heated and held before it is transferred to storage.
After a series of batches the tank is cleaned in place by the CIP station.

![Plant overview](assets/plant-overview.svg)

## Overview

| Area | Unit | Strategies | Sequences |
|------|------|------------|-----------|
| Utilities | U110 Process water | P111, PIC112 | START_U110 |
| Dosing | U210 Mixing tank T210 | LIC210, FIC211, TIC213, FFIC214, AIC215, M216, XV217 | BATCH_T210 |
| Dosing | U220 Chemical store | LI221 | — |
| CIP | U310 CIP station | FIC311, TIC312, QIC313 | CIP_T210 |

## Conventions

* Tags follow ISA-5.1: \`FIC\` flow controller, \`LIC\` level controller,
  \`TIC\` temperature controller, \`AIC\` analyser controller, \`QIC\`
  quantity (conductivity) controller, \`XV\` on/off valve, \`M\` motor.
* Interlock signals are **TRUE = healthy**; they are drawn as red dashed lines.
* Alarm signals to the operator are drawn orange, tracking signals grey dotted.
* Links marked **z⁻¹** use the value of the previous cycle (the source block
  runs after the target block).
* Company blocks come from the library \`acme\`:

| Block | Kind | Purpose |
|-------|------|---------|
| \`acme/DUTY_STANDBY\` | composite | Two fixed-speed pumps with automatic changeover |
| \`acme/AI_2OO3\` | composite | Median of three transmitters with deviation alarm |
| \`acme/TANK_VOL\` | basic (SCL) | Volume of a vertical tank with conical bottom |

## Sequences and strategies

The sequences only write commands to strategy inputs (start pumps, enable
cascades, set setpoints) and read process values in their transitions. Some
strategies read sequence states back, for example the outlet valve XV217
opens while step \`BATCH_T210:S60\` (transfer) is active.
`;

const OVERVIEW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 300" width="760" height="300" font-family="Helvetica, Arial, sans-serif" font-size="12">
  <rect x="0" y="0" width="760" height="300" fill="#ffffff"/>
  <g fill="none" stroke="#9aa3a8" stroke-width="1.2">
    <rect x="10" y="10" width="190" height="280" rx="6" fill="#f3f6f9"/>
    <rect x="215" y="10" width="345" height="280" rx="6" fill="#f6f4ee"/>
    <rect x="575" y="10" width="175" height="280" rx="6" fill="#f1f6f1"/>
  </g>
  <g font-weight="bold" fill="#1d2328">
    <text x="20" y="30">Utilities</text>
    <text x="225" y="30">Dosing</text>
    <text x="585" y="30">CIP</text>
  </g>
  <!-- lines (drawn first, tanks and pumps on top) -->
  <g fill="none" stroke-width="2">
    <path d="M75 190 V200 H136 M75 200 V240 H136" stroke="#1f5f8b"/>
    <path d="M164 200 H180 M164 240 H180 V45 H375 V75" stroke="#1f5f8b"/>
    <path d="M262 200 V150 H330" stroke="#c2571a"/>
    <path d="M502 200 V170 H420" stroke="#a3123a"/>
    <path d="M655 195 V226" stroke="#2f7d4a"/>
    <path d="M669 240 H720 V55 H400 V75" stroke="#2f7d4a" stroke-dasharray="5 3"/>
  </g>
  <!-- tanks -->
  <g stroke="#1d2328" stroke-width="1.5" fill="#dfeaf3">
    <path d="M40 60 h70 v110 l-35 20 l-35 -20 z"/>
    <path d="M330 75 h90 v130 l-45 25 l-45 -25 z"/>
    <rect x="240" y="200" width="45" height="65" rx="4" fill="#f6eedb"/>
    <rect x="480" y="200" width="45" height="65" rx="4" fill="#f4e4ec"/>
    <path d="M620 75 h70 v100 l-35 20 l-35 -20 z" fill="#e2f0e6"/>
  </g>
  <!-- pumps -->
  <g stroke="#1d2328" stroke-width="1.5" fill="#ffffff">
    <circle cx="150" cy="200" r="14"/>
    <circle cx="150" cy="240" r="14"/>
    <circle cx="655" cy="240" r="14"/>
  </g>
  <g fill="#1d2328" text-anchor="middle">
    <text x="75" y="120">T110</text>
    <text x="375" y="145">T210</text>
    <text x="262" y="230">T221</text>
    <text x="502" y="230">T222</text>
    <text x="655" y="130">T310</text>
    <text x="150" y="204" font-size="10">A</text>
    <text x="150" y="244" font-size="10">B</text>
    <text x="655" y="244" font-size="10">P</text>
  </g>
  <g fill="#5b6670" font-size="10" text-anchor="middle">
    <text x="262" y="250">caustic</text>
    <text x="502" y="250">acid</text>
    <text x="150" y="268">P111A / P111B</text>
    <text x="655" y="268">P311</text>
  </g>
  <g fill="#1d2328" font-size="10">
    <text x="230" y="60">process water</text>
    <text x="600" y="48">CIP supply</text>
    <text x="268" y="142">FFIC214</text>
    <text x="428" y="162">AIC215</text>
  </g>
  <g fill="#1d2328" font-size="11" font-style="italic" text-anchor="middle">
    <text x="105" y="283">U110 Process water</text>
    <text x="375" y="250">U210 Mixing tank</text>
    <text x="382" y="283">U220 Chemical store</text>
    <text x="662" y="283">U310 CIP station</text>
  </g>
</svg>
`;

const T210_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 300" width="520" height="300" font-family="Helvetica, Arial, sans-serif" font-size="11">
  <rect width="520" height="300" fill="#ffffff"/>
  <path d="M200 60 h120 v160 l-60 30 l-60 -30 z" fill="#dfeaf3" stroke="#1d2328" stroke-width="1.5"/>
  <path d="M190 120 h-10 v90 h10 M330 120 h10 v90 h-10" fill="none" stroke="#c2571a" stroke-width="2"/>
  <line x1="260" y1="30" x2="260" y2="190" stroke="#1d2328" stroke-width="2"/>
  <path d="M235 190 h50" stroke="#1d2328" stroke-width="3"/>
  <circle cx="260" cy="22" r="10" fill="#ffffff" stroke="#1d2328" stroke-width="1.5"/>
  <text x="260" y="26" text-anchor="middle" font-size="9">M</text>
  <text x="278" y="26">M216 agitator</text>
  <path d="M16 70 h184" fill="none" stroke="#1f5f8b" stroke-width="2"/>
  <text x="16" y="62">process water FV211 / FT211</text>
  <path d="M16 100 h184" fill="none" stroke="#c2571a" stroke-width="2"/>
  <text x="16" y="92">caustic XV214 / FT214</text>
  <path d="M16 140 h164" fill="none" stroke="#a3123a" stroke-width="2"/>
  <text x="16" y="132">acid SC215</text>
  <path d="M380 140 h-40" fill="none" stroke="#c2571a" stroke-width="2"/>
  <text x="385" y="135">steam TV213H</text>
  <path d="M380 190 h-40" fill="none" stroke="#1f5f8b" stroke-width="2"/>
  <text x="385" y="185">cooling water TV213C</text>
  <path d="M260 250 v30 h-110 M260 280 h120" fill="none" stroke="#1d2328" stroke-width="2"/>
  <text x="70" y="294">XV217 to storage</text>
  <text x="390" y="294">XV218 drain</text>
  <g fill="#ffffff" stroke="#1d2328">
    <circle cx="350" cy="80" r="14"/>
    <circle cx="350" cy="230" r="14"/>
    <circle cx="160" cy="230" r="14"/>
  </g>
  <g text-anchor="middle" font-size="9">
    <text x="350" y="83">LT210</text>
    <text x="350" y="233">TT213</text>
    <text x="160" y="233">AT215</text>
  </g>
  <text x="212" y="80" font-weight="bold">T210</text>
  <text x="212" y="94">12 m³</text>
</svg>
`;

// ---------------------------------------------------------------------------
// Company library `acme`
// ---------------------------------------------------------------------------

const LIB = `format: csd-library/1
uid: ${uid(2)}
name: ACME company blocks
version: 1.0.0
description: Company standard blocks shared across ACME plants — redundant measurements, pump groups and tank calculations.
`;

const DUTY_STANDBY = `format: csd-blocktype/1
uid: ${uid(3)}
type: DUTY_STANDBY
version: 1.0.0
category: Devices
kind: composite
description: Two fixed-speed pumps, one duty and one standby, with automatic changeover on fault of the duty pump
inputs:
  - { name: SEL_B, type: BOOL, description: TRUE = pump B is duty, default: false }
  - { name: RUN, type: BOOL, description: Run request (level) from operator or sequence }
  - { name: FB_A, type: BOOL, description: Running feedback pump A }
  - { name: FB_B, type: BOOL, description: Running feedback pump B }
  - { name: INTLK, type: BOOL, description: Interlock — FALSE trips both pumps, default: true }
outputs:
  - { name: CMD_A, type: BOOL, description: Run command pump A }
  - { name: CMD_B, type: BOOL, description: Run command pump B }
  - { name: RUNNING, type: BOOL, description: At least one pump runs }
  - { name: FAULT, type: BOOL, description: Both pumps failed }
params:
  - { name: FB_TIME, type: TIME, default: 5s, description: Feedback monitoring time of both pumps }
diagram:
  blocks:
    DUTY_A: { type: NOT, description: Pump A is duty, order: 10, pos: [240, 190] }
    STOP: { type: NOT, description: No run request, order: 20, pos: [700, 550] }
    WANT_A: { type: OR, description: A is duty or B failed, order: 30, pos: [470, 190] }
    WANT_B: { type: OR, description: B is duty or A failed, order: 40, pos: [470, 370] }
    RUN_A: { type: AND, order: 50, pos: [700, 190] }
    RUN_B: { type: AND, order: 60, pos: [700, 370] }
    MA: { type: MOTOR, description: Pump A, order: 70, pos: [940, 190], params: { FB_TIME: $FB_TIME } }
    MB: { type: MOTOR, description: Pump B, order: 80, pos: [940, 370], params: { FB_TIME: $FB_TIME } }
    ANY_RUN: { type: OR, order: 90, pos: [1180, 190] }
    BOTH_FLT: { type: AND, order: 100, pos: [1180, 370] }
  links:
    - in.SEL_B -> DUTY_A.IN
    - in.RUN -> STOP.IN
    - DUTY_A.OUT -> WANT_A.IN1
    - MB.FAULT -> WANT_A.IN2
    - in.SEL_B -> WANT_B.IN1
    - MA.FAULT -> WANT_B.IN2
    - in.RUN -> RUN_A.IN1
    - WANT_A.OUT -> RUN_A.IN2
    - in.RUN -> RUN_B.IN1
    - WANT_B.OUT -> RUN_B.IN2
    - RUN_A.OUT -> MA.START
    - STOP.OUT -> MA.STOP
    - in.INTLK -> MA.INTLK
    - in.FB_A -> MA.FB_RUN
    - RUN_B.OUT -> MB.START
    - STOP.OUT -> MB.STOP
    - in.INTLK -> MB.INTLK
    - in.FB_B -> MB.FB_RUN
    - MA.RUNNING -> ANY_RUN.IN1
    - MB.RUNNING -> ANY_RUN.IN2
    - MA.FAULT -> BOTH_FLT.IN1
    - MB.FAULT -> BOTH_FLT.IN2
    - MA.CMD -> out.CMD_A
    - MB.CMD -> out.CMD_B
    - ANY_RUN.OUT -> out.RUNNING
    - BOTH_FLT.OUT -> out.FAULT
  notes:
    - text: The FAULT of the other pump is read from the previous cycle (z⁻¹), so a failed duty pump hands over to the standby pump within one scan. A change of the duty selector takes effect at the next start.
`;

const AI_2OO3 = `format: csd-blocktype/1
uid: ${uid(4)}
type: AI_2OO3
version: 1.0.0
category: I/O
kind: composite
description: Redundant measurement, median of three transmitters with deviation alarm
inputs: []
outputs:
  - { name: PV, type: REAL, description: Median of the three measurements }
  - { name: DEV_ALM, type: BOOL, description: Spread between transmitters above DEV_LIM }
params:
  - { name: CH_A, type: STRING, description: Channel of transmitter A }
  - { name: CH_B, type: STRING, description: Channel of transmitter B }
  - { name: CH_C, type: STRING, description: Channel of transmitter C }
  - { name: PV_HI, type: REAL, default: 100, description: Range high }
  - { name: UNIT, type: STRING, default: "%", description: Engineering unit }
  - { name: DEV_LIM, type: REAL, default: 2.0, description: Allowed spread }
diagram:
  blocks:
    TT_A: { type: AI, params: { CHANNEL: $CH_A, PV_HI: $PV_HI, UNIT: $UNIT } }
    TT_B: { type: AI, params: { CHANNEL: $CH_B, PV_HI: $PV_HI, UNIT: $UNIT } }
    TT_C: { type: AI, params: { CHANNEL: $CH_C, PV_HI: $PV_HI, UNIT: $UNIT } }
    MED: { type: MID }
    HI: { type: MAX }
    LO: { type: MIN }
    SPAN: { type: SUB }
    CHK: { type: CMP, params: { IN2: $DEV_LIM } }
  links:
    - TT_A.PV -> MED.IN1
    - TT_B.PV -> MED.IN2
    - TT_C.PV -> MED.IN3
    - TT_A.PV -> HI.IN1
    - TT_B.PV -> HI.IN2
    - TT_C.PV -> HI.IN3
    - TT_A.PV -> LO.IN1
    - TT_B.PV -> LO.IN2
    - TT_C.PV -> LO.IN3
    - HI.OUT -> SPAN.IN1
    - LO.OUT -> SPAN.IN2
    - SPAN.OUT -> CHK.IN1
    - MED.OUT -> out.PV
    - CHK.GT -> out.DEV_ALM
`;

const TANK_VOL = `format: csd-blocktype/1
uid: ${uid(5)}
type: TANK_VOL
version: 1.0.0
category: Math
color: "#e6eef0"
kind: basic
description: Volume and filling degree of a vertical cylindrical tank with conical bottom
inputs:
  - { name: LEVEL, type: REAL, description: Level above the cone tip, unit: m }
outputs:
  - { name: VOL, type: REAL, description: Volume, unit: m3 }
  - { name: PCT, type: REAL, description: Filling degree, unit: "%" }
params:
  - { name: DIAM, type: REAL, default: 2.0, description: Inner diameter, unit: m }
  - { name: H_CONE, type: REAL, default: 0.5, description: Height of the conical bottom, unit: m }
  - { name: H_TOTAL, type: REAL, default: 3.0, description: Height at 100 % (overflow), unit: m }
implementation:
  language: SCL
  source: |
    FUNCTION_BLOCK TANK_VOL
    VAR_INPUT  LEVEL : REAL; END_VAR
    VAR_OUTPUT VOL : REAL; PCT : REAL; END_VAR
    VAR
      DIAM : REAL := 2.0; H_CONE : REAL := 0.5; H_TOTAL : REAL := 3.0;
      A : REAL; R : REAL; V_MAX : REAL; H : REAL;
    END_VAR

    H := LIMIT(0.0, LEVEL, H_TOTAL);
    A := 3.14159 * DIAM * DIAM / 4.0;
    IF H <= H_CONE THEN
      R := DIAM / 2.0 * H / H_CONE;          (* radius at the surface *)
      VOL := 3.14159 * R * R * H / 3.0;
    ELSE
      VOL := A * H_CONE / 3.0 + A * (H - H_CONE);
    END_IF;
    V_MAX := A * H_CONE / 3.0 + A * (H_TOTAL - H_CONE);
    PCT := 100.0 * VOL / V_MAX;
    END_FUNCTION_BLOCK
`;

// ---------------------------------------------------------------------------
// Area Utilities — U110 Process water
// ---------------------------------------------------------------------------

const P111 = `format: csd-strategy/1
uid: ${uid(10)}
strategy: P111
title: Process water pumps P111A / P111B
description: Duty / standby pump pair feeding the process water header from tank T110.
revision: B
scan: 500ms

sheets:
  - { id: 1, title: Pump group }
  - { id: 2, title: Interlocks }

blocks:
  HS111:
    type: DI
    description: Duty selector on MCC (TRUE = B duty)
    order: 10
    params: { CHANNEL: HS111 }
  P111A_FB:
    type: DI
    description: P111A running feedback
    order: 20
    params: { CHANNEL: P111A_RUN }
  P111B_FB:
    type: DI
    description: P111B running feedback
    order: 30
    params: { CHANNEL: P111B_RUN }
  LSL110:
    type: DI
    description: T110 low level switch, inverted (TRUE = level OK)
    sheet: 2
    order: 40
    params: { CHANNEL: LSL110, INVERT: true, DEBOUNCE: 2s }
  PT112_OK:
    type: CMP
    description: Header pressure below 8 bar
    sheet: 2
    order: 45
    params: { IN2: 8.0, HYST: 0.2 }
  P111_ILK:
    type: INTLK
    description: Pump group interlock
    sheet: 2
    order: 50
    params: { LATCH: true }
  P111:
    type: acme/DUTY_STANDBY@1.0.0
    description: Process water pump group
    order: 60
    params: { FB_TIME: 8s }
    comment: RUN is written by sequence START_U110.
  P111A_CMD:
    type: DO
    description: P111A starter
    order: 70
    params: { CHANNEL: P111A_CMD }
  P111B_CMD:
    type: DO
    description: P111B starter
    order: 80
    params: { CHANNEL: P111B_CMD }

links:
  - P111A_FB.OUT -> P111.FB_A
  - P111B_FB.OUT -> P111.FB_B
  - HS111.OUT -> P111.SEL_B
  - P111.CMD_A -> P111A_CMD.IN
  - P111.CMD_B -> P111B_CMD.IN
  - LSL110.OUT -> P111_ILK.IN1
  - from: PIC112:PT112.PV
    to: PT112_OK.IN1
    comment: Dead-head protection
  - PT112_OK.LT -> P111_ILK.IN2
  - from: P111_ILK.OUT
    to: P111.INTLK
    label: P111_ILK
    category: interlock

notes:
  - text: Changeover to the standby pump on a fault of the duty pump is automatic (acme/DUTY_STANDBY).
  - text: The interlock latches; reset from the faceplate after the cause is gone.
    sheet: 2
`;

const P111_MD = `## Function

Two identical centrifugal pumps P111A and P111B feed the process water header
from tank T110. One pump is **duty**, the other **standby** (selector HS111 on
the MCC). The pump group block \`acme/DUTY_STANDBY\` starts the duty pump on a
run request and changes over to the standby pump when the duty pump fails.

## Interlocks

| No. | Condition (healthy) | Source | Effect |
|-----|---------------------|--------|--------|
| 1 | T110 level not low | LSL110 | Both pumps stop |
| 2 | Header pressure below 8 bar | PIC112 / PT112 | Both pumps stop |

The interlock is latched and reset from the operator faceplate.

## Commands

The run request \`P111.RUN\` is written by the sequence **START_U110**
(start-up and shut-down of the process water supply).
`;

const PIC112 = `format: csd-strategy/1
uid: ${uid(11)}
strategy: PIC112
title: Process water header pressure
description: Keeps the header pressure by recirculating water back to T110; common alarm of the utilities.
scan: 500ms

sheets:
  - { id: 1, title: Pressure control }
  - { id: 2, title: Alarms }

blocks:
  PT112:
    type: AI
    description: Header pressure
    order: 10
    params: { CHANNEL: PT112, PV_HI: 10, UNIT: bar, FILTER_T: 1s }
  PAH112:
    type: LIM_ALM
    description: Header pressure limits
    order: 20
    params: { H: 7.5, L: 2.0, HYST: 0.1, DELAY: 3s }
  NO_PUMP:
    type: NOT
    description: No process water pump runs
    order: 30
  PIC112:
    type: PID
    description: Header pressure controller
    order: 40
    params: { GAIN: 0.6, TI: 8s, DIRECTION: DIRECT, SP_INT: 4.0, SP_HI: 6.0, PV_HI: 10, UNIT: bar, TRK_VAL: 100 }
    comment: DIRECT — rising pressure opens the recirculation valve.
  PV112:
    type: AO
    description: Recirculation valve (fail open)
    order: 50
    scan: 100ms
    params: { CHANNEL: PV112, FAIL_SAFE: MAX }
  XA110:
    type: OR
    description: Utilities common alarm
    sheet: 2
    order: 60
  XA110_DO:
    type: DO
    description: Alarm beacon utilities
    sheet: 2
    order: 70
    params: { CHANNEL: XA110 }

links:
  - PT112.PV -> PIC112.PV
  - PT112.PV -> PAH112.IN
  - P111:P111.RUNNING -> NO_PUMP.IN
  - from: NO_PUMP.OUT
    to: PIC112.TRK_ON
    category: tracking
    comment: Valve fully open while no pump runs
  - PIC112.MV -> PV112.IN
  - from: PAH112.QH
    to: XA110.IN1
    label: PAH112
    category: alarm
  - from: PAH112.QL
    to: XA110.IN2
    label: PAL112
    category: alarm
  - XA110.OUT -> XA110_DO.IN
`;

const PIC112_MD = `## Function

The header pressure is held at **4.0 bar** by the recirculation valve PV112
back to tank T110. The controller acts **direct**: a rising pressure opens the
valve. While no pump runs, the output tracks 100 % so the pump starts against
an open recirculation (no pressure surge).

## Alarms

| Tag | Limit | Delay | Meaning |
|-----|-------|-------|---------|
| PAH112 | 7.5 bar | 3 s | Header pressure high |
| PAL112 | 2.0 bar | 3 s | Header pressure low |

The alarms of the utilities area drive the beacon XA110 (sheet 2). Above
8 bar the pumps trip (interlock in P111).
`;

const START_U110 = `format: csd-sequence/1
uid: ${uid(12)}
sequence: START_U110
title: Start-up and shut-down of the process water supply
description: Starts the duty pump against an open recirculation valve and waits for the header pressure.
scan: 1s

inputs:
  - { name: START_CMD, type: BOOL, description: Operator start }
  - { name: STOP_CMD, type: BOOL, description: Operator stop }
  - { name: ACK_CMD, type: BOOL, description: Operator acknowledges a failed start }

steps:
  S0:
    initial: true
    description: Supply off
  S10:
    description: Check recirculation open
    actions:
      - { q: N, text: PV112 tracks 100 % while no pump runs (PIC112) }
    time: { max: 30s }
  S20:
    description: Start duty pump
    actions:
      - { q: S, set: P111:P111.RUN }
    time: { max: 20s }
  S30:
    description: Build up header pressure
    actions:
      - { q: N, text: PIC112 closes the recirculation to 4 bar }
    time: { max: 2min }
  S40:
    description: Supply in operation
    actions:
      - { q: N, text: Process water available for T210 and CIP }
  S50:
    description: Stop pumps
    actions:
      - { q: R, set: P111:P111.RUN }
    time: { max: 30s }
  S90:
    description: Start failed
    actions:
      - { q: R, set: P111:P111.RUN }
      - { q: N, text: Alarm "Process water start failed" to the operator }

transitions:
  - { from: S0, to: S10, condition: START_CMD and P111:LSL110.OUT, comment: T110 level OK }
  - { from: S10, to: S20, condition: PIC112:PV112.OUT_RB > 90 or S10.T > 15s, comment: Valve open }
  - { from: S20, to: S30, condition: P111:P111.RUNNING }
  - { from: S20, to: S90, condition: S20.T > 15s, comment: No running feedback }
  - { from: S30, to: S40, condition: PIC112:PT112.PV >= 3.5 and S30.T > 10s }
  - { from: S40, to: S50, condition: STOP_CMD or not P111:P111.RUNNING, comment: Stop or both pumps failed }
  - { from: S50, to: S0, condition: not P111:P111.RUNNING }
  - { from: S90, to: S0, condition: ACK_CMD }
`;

const START_U110_MD = `## Function

Start-up and shut-down of the process water supply.

1. While no pump runs, PIC112 tracks its output to 100 % — the recirculation
   valve PV112 is open, so the duty pump starts without a pressure surge. The
   sequence waits for the valve readback.
2. The duty pump of the group P111 is started. If it does not report running
   within 15 s the sequence goes to **S90 Start failed** and waits for the
   operator.
3. With a pump running the tracking ends and PIC112 builds up the header
   pressure; at 3.5 bar the supply is **in operation** (S40).
4. On a stop command, or when no pump runs any more, the pumps are stopped;
   the recirculation valve opens again by tracking.

The CIP sequence CIP_T210 only starts while this sequence is in step S40
(\`START_U110:S40.X\`).
`;

// ---------------------------------------------------------------------------
// Area Dosing — U210 Mixing tank T210
// ---------------------------------------------------------------------------

const LIC210 = `format: csd-strategy/1
uid: ${uid(20)}
strategy: LIC210
title: Mixing tank T210 level
description: Level master of the water inlet cascade with 2oo3 level measurement and tank alarms.
scan: 1s

blocks:
  LT210:
    type: acme/AI_2OO3
    description: T210 level, 2oo3 transmitters
    order: 10
    params: { CH_A: LT210A, CH_B: LT210B, CH_C: LT210C, PV_HI: 3.0, UNIT: m, DEV_LIM: 0.05 }
  LAL210:
    type: LIM_ALM
    description: T210 level limits
    order: 20
    params: { H: 2.7, L: 0.3, HYST: 0.02, DELAY: 2s }
  LS210A:
    type: CMP
    description: Agitator blades covered (0.5 m)
    order: 22
    params: { IN2: 0.5, HYST: 0.05 }
  LS210E:
    type: CMP
    description: T210 empty (0.1 m)
    order: 24
    params: { IN2: 0.1, HYST: 0.02 }
  LIC210:
    type: PID
    description: T210 level controller
    order: 30
    params: { GAIN: 1.5, TI: 240s, SP_INT: 2.4, SP_HI: 2.6, PV_HI: 3.0, UNIT: m, MV_HI: 12 }
    comment: MV is the flow setpoint of FIC211 in m3/h.
  XA210:
    type: OR
    description: T210 common alarm
    order: 40
  XA210_DO:
    type: DO
    description: Alarm beacon T210
    order: 50
    params: { CHANNEL: XA210 }

links:
  - LT210.PV -> LIC210.PV
  - LT210.PV -> LAL210.IN
  - LT210.PV -> LS210A.IN1
  - LT210.PV -> LS210E.IN1
  - from: LAL210.QH
    to: XA210.IN1
    label: LAH210
    category: alarm
  - from: LAL210.QL
    to: XA210.IN2
    label: LAL210
    category: alarm
  - from: LT210.DEV_ALM
    to: XA210.IN3
    label: LDA210
    category: alarm
  - XA210.OUT -> XA210_DO.IN
`;

const LIC210_MD = `## Function

Master controller of the cascade **LIC210 → FIC211**. The level is measured
by three transmitters (\`acme/AI_2OO3\`, median selection); a spread of more
than 5 cm between them raises the alarm LDA210.

The controller output is the flow setpoint of FIC211 in m³/h (0–12 m³/h). The
cascade is only active while the batch sequence fills the tank (FIC211
\`SP_EXT_ON\` is set by BATCH_T210 step S10).

## Alarms

| Tag | Limit | Meaning |
|-----|-------|---------|
| LAH210 | 2.7 m | Level high, overflow at 3.0 m |
| LAL210 | 0.3 m | Level low |
| LDA210 | 0.05 m | Spread between transmitters |

## Level switches (software)

| Block | Limit | Used by |
|-------|-------|---------|
| LS210A.GT | > 0.5 m, blades covered | M216 interlock, BATCH_T210 |
| LS210E.LT | < 0.1 m, tank empty | BATCH_T210, CIP_T210 |
`;

const FIC211 = `format: csd-strategy/1
uid: ${uid(21)}
strategy: FIC211
title: Process water inlet to T210
description: Inlet flow control (cascade slave of LIC210) with batch totaliser.
scan: 500ms

blocks:
  FT211:
    type: AI
    description: Process water flow to T210
    order: 10
    params: { CHANNEL: FT211, PV_HI: 15, UNIT: m3/h, FILTER_T: 2s }
  FIC211:
    type: PID
    description: Inlet flow controller
    order: 20
    params: { GAIN: 0.5, TI: 6s, SP_HI: 12, PV_HI: 15, UNIT: m3/h }
    comment: Tuned at commissioning, 2026-03.
  FV211:
    type: AO
    description: Inlet control valve (fail closed)
    order: 30
    scan: 100ms
    params: { CHANNEL: FV211, FAIL_SAFE: MIN }
  FQ211:
    type: TOTAL
    description: Batch water quantity
    order: 40
    params: { T_BASE: h, UNIT: m3 }

links:
  - FT211.PV -> FIC211.PV
  - from: LIC210:LIC210.MV
    to: FIC211.SP_EXT
    label: FIC211_SP
    comment: Cascade from level master
  - FIC211.MV -> FV211.IN
  - from: FV211.OUT_RB
    to: FIC211.TRK_VAL
    category: tracking
    comment: Bumpless return from manual
  - FT211.PV -> FQ211.IN

notes:
  - text: FT211.PV is also the lead signal of the ratio dosing FFIC214 and the feed-forward of the pH control AIC215.
`;

const FIC211_MD = `## Function

Slave controller of the level cascade. In automatic the setpoint comes from
**LIC210** (\`SP_EXT_ON\` is set by the batch sequence). The totaliser FQ211
counts the water of the current batch; it is reset by BATCH_T210 at the start
of filling.

The valve readback is fed back to the tracking input so the controller
returns bumplessly from manual. This link runs from a later block (order 30)
to an earlier one (order 20) and therefore uses the value of the previous
cycle (z⁻¹).
`;

const TIC213 = `format: csd-strategy/1
uid: ${uid(22)}
strategy: TIC213
title: T210 jacket temperature (split range)
description: Heating with steam and cooling with cooling water through the tank jacket, one controller with split range.
scan: 1s

sheets:
  - { id: 1, title: Split range control }
  - { id: 2, title: Heating permissive }

blocks:
  TT213:
    type: AI
    description: T210 product temperature
    order: 10
    params: { CHANNEL: TT213, PV_HI: 120, UNIT: °C, LIM_HH: 85 }
  TIC213:
    type: PID
    description: T210 temperature controller
    order: 20
    params: { GAIN: 3.0, TI: 180s, TD: 20s, SP_INT: 20, SP_HI: 80, PV_HI: 120, UNIT: °C }
    comment: Setpoint from BATCH_T210 (SP_EXT).
  TY213:
    type: SPLIT
    description: 0–50 % cooling, 50–100 % heating
    order: 30
    params: { SPLIT_PT: 50 }
  TY213C:
    type: SCALE
    description: Invert cooling range
    order: 40
    params: { IN_LO: 0, IN_HI: 100, OUT_LO: 100, OUT_HI: 0 }
    display: { params: false }
  TV213C:
    type: AO
    description: Cooling water valve (fail open)
    order: 50
    params: { CHANNEL: TV213C, FAIL_SAFE: MAX }
  TAHH_OK:
    type: NOT
    description: Temperature not high-high
    sheet: 2
    order: 52
  HEAT_ILK:
    type: INTLK
    description: Heating permissive
    sheet: 2
    order: 54
  NO_HEAT:
    type: NOT
    description: Heating blocked
    sheet: 2
    order: 56
  TY213H:
    type: SEL
    description: Steam closed when blocked
    sheet: 2
    order: 60
    params: { IN1: 0 }
  TV213H:
    type: AO
    description: Steam valve (fail closed)
    order: 70
    pos: [1350, 170]
    params: { CHANNEL: TV213H, FAIL_SAFE: MIN }

links:
  - TT213.PV -> TIC213.PV
  - TIC213.MV -> TY213.IN
  - TY213.OUT1 -> TY213C.IN
  - TY213C.OUT -> TV213C.IN
  - TY213.OUT2 -> TY213H.IN0
  - TY213H.OUT -> TV213H.IN
  - TT213.HH -> TAHH_OK.IN
  - TAHH_OK.OUT -> HEAT_ILK.IN1
  - from: M216:M216.RUNNING
    to: HEAT_ILK.IN2
    comment: No heating without agitation
  - from: HEAT_ILK.OUT
    to: NO_HEAT.IN
    label: HEAT_PERM
    category: interlock
  - NO_HEAT.OUT -> TY213H.G

notes:
  - text: The cooling valve fails open, the steam valve fails closed — on loss of air the jacket cools.
`;

const TIC213_MD = `## Function

One controller TIC213 acts on two valves of the tank jacket. The controller
output is divided by the split range block TY213:

* **0–50 %** — cooling: the cooling water valve TV213C closes from 100 % to 0 %
  (inverted by TY213C),
* **50–100 %** — heating: the steam valve TV213H opens from 0 % to 100 %.

At 50 % both valves are closed (no heating, no cooling).

\`\`\`chart
type: line
title: Split range TV213C / TV213H
x: { label: "Controller output TIC213.MV [%]", min: 0, max: 100 }
y: { label: "Valve opening [%]", min: 0, max: 100 }
series:
  - { name: TV213C cooling, points: [[0, 100], [50, 0], [100, 0]] }
  - { name: TV213H steam, points: [[0, 0], [50, 0], [100, 100]] }
\`\`\`

## Heating permissive

Steam is only allowed when

| No. | Condition | Source |
|-----|-----------|--------|
| 1 | Temperature below high-high (85 °C) | TT213.HH |
| 2 | Agitator running | M216 |

When the permissive is lost the steam valve closes immediately; cooling stays
available. The permissive latches and is reset from the faceplate.

## Setpoint

The batch sequence writes the setpoint (\`SP_EXT\`, 65 °C) and switches to the
external setpoint in step S30 *Heat to reaction temperature*.
`;

const FFIC214 = `format: csd-strategy/1
uid: ${uid(23)}
strategy: FFIC214
title: Caustic ratio dosing to T210
description: Caustic flow proportional to the process water flow, with dosing valve and empty-tank interlock.
scan: 500ms

sheets:
  - { id: 1, title: Ratio control }
  - { id: 2, title: Dosing valve XV214 }

blocks:
  FT214:
    type: AI
    description: Caustic flow
    order: 10
    params: { CHANNEL: FT214, PV_HI: 400, UNIT: l/h }
  FY214:
    type: RATIO
    description: 25 l caustic per m3 water
    order: 20
    params: { RATIO: 25, BIAS: 0 }
  DOSE_OFF:
    type: OR
    description: Valve closed or caustic tank low
    order: 25
  FFIC214:
    type: PID
    description: Caustic flow controller
    order: 30
    params: { GAIN: 0.4, TI: 10s, SP_EXT_ON: true, SP_HI: 400, PV_HI: 400, UNIT: l/h, TRK_VAL: 0 }
    display: { params: false }
  SC214:
    type: AO
    description: Dosing pump P214 speed
    order: 40
    params: { CHANNEL: SC214 }
  T221_OK:
    type: NOT
    description: Caustic tank not low
    sheet: 2
    order: 42
  XV214_ZSO:
    type: DI
    description: XV214 open
    sheet: 2
    order: 44
    params: { CHANNEL: XV214_ZSO }
  XV214_ZSC:
    type: DI
    description: XV214 closed
    sheet: 2
    order: 46
    params: { CHANNEL: XV214_ZSC }
  XV214:
    type: VALVE
    description: Caustic dosing valve
    sheet: 2
    order: 50
    pos: [440, 24]
    params: { TRAVEL_T: 5s }
    comment: OPEN is set and reset by BATCH_T210.
  XV214_CMD:
    type: DO
    description: XV214 solenoid
    sheet: 2
    order: 60
    pos: [800, 24]
    params: { CHANNEL: XV214_CMD }

links:
  - from: FIC211:FT211.PV
    to: FY214.IN
    label: FI211
    comment: Lead flow
  - FY214.OUT -> FFIC214.SP_EXT
  - FT214.PV -> FFIC214.PV
  - FFIC214.MV -> SC214.IN
  - XV214_ZSO.OUT -> XV214.FB_OPN
  - XV214_ZSC.OUT -> XV214.FB_CLS
  - LI221:LAL221.QL -> T221_OK.IN
  - from: T221_OK.OUT
    to: XV214.INTLK
    label: XV214_ILK
    category: interlock
  - XV214.CMD -> XV214_CMD.IN
  - from: XV214.CLOSED
    to: DOSE_OFF.IN1
    category: tracking
  - LI221:LAL221.QL -> DOSE_OFF.IN2
  - from: DOSE_OFF.OUT
    to: FFIC214.TRK_ON
    category: tracking
`;

const FFIC214_MD = `## Function

Caustic is dosed in proportion to the process water flow FT211 while the tank
is filled (**ratio control**). The ratio station FY214 calculates the caustic
setpoint:

| Water flow FT211 | Ratio | Caustic setpoint |
|------------------|-------|------------------|
| 4 m³/h | 25 l/m³ | 100 l/h |
| 8 m³/h | 25 l/m³ | 200 l/h |
| 12 m³/h | 25 l/m³ | 300 l/h |

The dosing valve XV214 is opened and closed by the batch sequence. While it
is closed the controller output tracks 0 % so the pump does not run against a
closed valve. The valve closes when the caustic tank T221 is low (interlock
from LI221).
`;

const AIC215 = `format: csd-strategy/1
uid: ${uid(24)}
strategy: AIC215
title: T210 pH control with feed-forward
description: Acid dosing to neutralise the batch; the water flow is fed forward through a lead-lag.
scan: 1s

blocks:
  AT215:
    type: acme/AI_2OO3
    description: T210 pH, 2oo3 analysers
    order: 10
    params: { CH_A: AT215A, CH_B: AT215B, CH_C: AT215C, PV_HI: 14, UNIT: pH, DEV_LIM: 0.3 }
  AAL215:
    type: LIM_ALM
    description: pH limits
    order: 20
    params: { H: 9.0, L: 5.0, HYST: 0.1, DELAY: 10s }
  FY215:
    type: LEADLAG
    description: Feed-forward from water flow
    order: 30
    pos: [221, 312]
    params: { GAIN: 0.8, T_LEAD: 20s, T_LAG: 60s }
    display: { params: false }
    comment: Gain identified in step tests.
  AIC215:
    type: PID
    description: pH controller
    order: 40
    params: { GAIN: 1.2, TI: 90s, DIRECTION: DIRECT, SP_INT: 7.0, SP_LO: 6.0, SP_HI: 8.0, PV_HI: 14, UNIT: pH, TRK_VAL: 0 }
  SC215:
    type: AO
    description: Acid dosing pump P215 speed
    order: 50
    params: { CHANNEL: SC215 }
  XA215:
    type: OR
    description: pH common alarm
    order: 60
  XA215_DO:
    type: DO
    description: Alarm to HMI
    order: 70
    params: { CHANNEL: XA215 }

links:
  - AT215.PV -> AIC215.PV
  - AT215.PV -> AAL215.IN
  - from: FIC211:FT211.PV
    to: FY215.IN
    label: FI211
  - from: FY215.OUT
    to: AIC215.FF
    label: FF215
  - AIC215.MV -> SC215.IN
  - from: LI221:LAL222.QL
    to: AIC215.TRK_ON
    label: T222_LOW
    category: interlock
    comment: Acid tank empty — pump stopped
  - from: AAL215.QH
    to: XA215.IN1
    label: AAH215
    category: alarm
  - from: AAL215.QL
    to: XA215.IN2
    label: AAL215
    category: alarm
  - from: AT215.DEV_ALM
    to: XA215.IN3
    label: ADA215
    category: alarm
  - XA215.OUT -> XA215_DO.IN
`;

const AIC215_MD = `## Function

The pH of the batch is kept at **7.0** by dosing acid with pump P215. The
controller acts direct (a higher pH needs more acid). The pH is measured by
three analysers with median selection (\`acme/AI_2OO3\`).

The caustic dosed with the water raises the pH long before the analysers see
it, so the water flow FT211 is **fed forward** through the lead-lag FY215 to
the controller output.

## Modes

The controller is in manual until the batch sequence switches it to
automatic in step S40 *pH adjustment*. The sequence continues when the
control error \`AIC215.ER\` stays within ±0.2 pH for 5 min; during the hold
step S50 the controller is back in manual at 0 %. When the acid tank T222 is
empty the output tracks 0 %.
`;

const M216 = `format: csd-strategy/1
uid: ${uid(25)}
strategy: M216
title: T210 agitator M216
description: Agitator with level and emergency stop interlock; started and stopped by the batch sequence.
scan: 500ms

blocks:
  HS216:
    type: DI
    description: Local emergency stop, inverted (TRUE = released)
    order: 10
    params: { CHANNEL: HS216_ESD, INVERT: true }
  M216_ILK:
    type: INTLK
    description: Agitator interlock
    order: 20
    pos: [470, 72]
  M216:
    type: MOTOR
    description: T210 agitator
    order: 40
    params: { FB_TIME: 5s }
  M216_CMD:
    type: DO
    description: Agitator starter
    order: 50
    params: { CHANNEL: M216_CMD }
  M216_FB:
    type: DI
    description: Agitator running feedback
    order: 30
    params: { CHANNEL: M216_RUN }

links:
  - HS216.OUT -> M216_ILK.IN1
  - from: LIC210:LS210A.GT
    to: M216_ILK.IN2
    comment: Blades covered
  - from: M216_ILK.OUT
    to: M216.INTLK
    label: M216_ILK
    category: interlock
  - M216_FB.OUT -> M216.FB_RUN
  - M216.CMD -> M216_CMD.IN
`;

const M216_MD = `## Function

The agitator M216 mixes the batch in T210. START is set and reset by the
batch sequence BATCH_T210 (steps S25 and S70).

## Interlocks

| No. | Condition (healthy) | Source |
|-----|---------------------|--------|
| 1 | Local emergency stop released | HS216 |
| 2 | Level above the agitator blades (0.5 m) | LIC210 / LS210A |

The running signal enables the steam heating of TIC213.
`;

const XV217 = `format: csd-strategy/1
uid: ${uid(26)}
strategy: XV217
title: T210 outlet and drain valves
description: Product outlet to storage and drain to waste water, opened by the steps of the batch and CIP sequences.
scan: 500ms

sheets:
  - { id: 1, title: Outlet to storage XV217 }
  - { id: 2, title: Drain XV218 }

blocks:
  LSH401:
    type: DI
    description: Storage tank T401 not full (inverted LSH401)
    order: 10
    params: { CHANNEL: LSH401, INVERT: true }
  TRANSFER:
    type: AND
    description: Transfer requested and storage not full
    order: 15
  NO_CIP:
    type: NOT
    description: CIP not running
    order: 20
  XV217_ZSO:
    type: DI
    description: XV217 open
    order: 25
    params: { CHANNEL: XV217_ZSO }
  XV217_ZSC:
    type: DI
    description: XV217 closed
    order: 30
    params: { CHANNEL: XV217_ZSC }
  XV217:
    type: VALVE
    description: Product outlet to storage
    order: 40
    params: { TRAVEL_T: 8s }
  XV217_CMD:
    type: DO
    description: XV217 solenoid
    order: 50
    params: { CHANNEL: XV217_CMD }
  DRAIN_REQ:
    type: OR
    description: Drain requested
    sheet: 2
    order: 60
  XV218_ZSO:
    type: DI
    description: XV218 open
    sheet: 2
    order: 70
    params: { CHANNEL: XV218_ZSO }
  XV218_ZSC:
    type: DI
    description: XV218 closed
    sheet: 2
    order: 80
    params: { CHANNEL: XV218_ZSC }
  XV218:
    type: VALVE
    description: Drain to waste water
    sheet: 2
    order: 90
    params: { TRAVEL_T: 8s }
  XV218_CMD:
    type: DO
    description: XV218 solenoid
    sheet: 2
    order: 100
    params: { CHANNEL: XV218_CMD }

links:
  - LSH401.OUT -> TRANSFER.IN1
  - from: BATCH_T210:S60.X
    to: TRANSFER.IN2
    comment: Batch step S60
  - TRANSFER.OUT -> XV217.OPEN
  - from: CIP_T210:SEQ.RUNNING
    to: NO_CIP.IN
  - from: NO_CIP.OUT
    to: XV217.INTLK
    label: XV217_ILK
    category: interlock
    comment: No product to storage during CIP
  - XV217_ZSO.OUT -> XV217.FB_OPN
  - XV217_ZSC.OUT -> XV217.FB_CLS
  - XV217.CMD -> XV217_CMD.IN
  - from: BATCH_T210:S80.X
    to: DRAIN_REQ.IN1
    comment: Batch rejected
  - from: CIP_T210:S20.X
    to: DRAIN_REQ.IN2
    comment: CIP pre-rinse drain
  - from: CIP_T210:S60.X
    to: DRAIN_REQ.IN3
    comment: CIP final drain
  - DRAIN_REQ.OUT -> XV218.OPEN
  - XV218_ZSO.OUT -> XV218.FB_OPN
  - XV218_ZSC.OUT -> XV218.FB_CLS
  - XV218.CMD -> XV218_CMD.IN
`;

const XV217_MD = `## Function

The valves at the bottom of T210 are not commanded by the sequences
directly — the strategy reads the **step signals** of the sequences:

| Valve | Opens while | Sequence step |
|-------|-------------|---------------|
| XV217 to storage | Batch transfer, storage T401 not full | BATCH_T210 S60 |
| XV218 drain | Batch rejected | BATCH_T210 S80 |
| XV218 drain | Pre-rinse drain | CIP_T210 S20 |
| XV218 drain | Final rinse and drain | CIP_T210 S60 |

The product outlet XV217 is interlocked while the CIP sequence runs, so no
cleaning solution can reach the product storage.
`;

const BATCH_T210 = `format: csd-sequence/1
uid: ${uid(27)}
sequence: BATCH_T210
title: Batch preparation in T210
description: Fills T210 with water and caustic, heats, neutralises and holds the batch, then transfers or drains it.
scan: 1s

sheets:
  - { id: 1, title: "Fill, dose and heat" }
  - { id: 2, title: "Neutralise, hold and transfer" }

inputs:
  - { name: START_CMD, type: BOOL, description: Operator starts a batch }
  - { name: LAB_OK, type: BOOL, description: Laboratory released the batch }
  - { name: LAB_REJECT, type: BOOL, description: Laboratory rejected the batch }

steps:
  S0:
    initial: true
    description: Idle, tank empty
  S10:
    description: Fill water to agitator level
    actions:
      - { q: P1, set: FIC211:FQ211.RESET }
      - { q: S, set: FIC211:FIC211.SP_EXT_ON }
    time: { max: 10min }
  S20:
    description: Fill and dose caustic
    actions:
      - { q: S, set: FFIC214:XV214.OPEN }
    time: { max: 60min }
  S22:
    description: Stop filling
    actions:
      - { q: R, set: FIC211:FIC211.SP_EXT_ON }
      - { q: R, set: FFIC214:XV214.OPEN }
  S25:
    description: Start agitator
    actions:
      - { q: S, set: M216:M216.START }
    time: { max: 30s }
  S27:
    description: Agitate
    actions:
      - { q: N, text: Agitator mixes while the tank fills }
  S30:
    description: Heat to reaction temperature
    sheet: 2
    actions:
      - { q: N, set: TIC213:TIC213.SP_EXT, value: 65 }
      - { q: S, set: TIC213:TIC213.SP_EXT_ON }
    time: { max: 45min }
  S40:
    description: pH adjustment
    sheet: 2
    actions:
      - { q: R, set: AIC215:AIC215.MAN_ON }
    time: { min: 5min, max: 30min }
  S50:
    description: Hold for reaction
    sheet: 2
    actions:
      - { q: S, set: AIC215:AIC215.MAN_ON }
      - { q: N, set: AIC215:AIC215.MAN_VAL, value: 0 }
      - { q: D, text: Take a sample for the laboratory, time: 15min }
    time: { min: 30min, max: 4h }
  S60:
    description: Transfer to storage
    sheet: 2
    actions:
      - { q: N, text: Outlet XV217 opens (XV217 reads S60.X) }
      - { q: R, set: TIC213:TIC213.SP_EXT_ON }
    time: { max: 40min }
  S80:
    description: Drain rejected batch
    sheet: 2
    actions:
      - { q: N, text: Drain XV218 opens (XV217 reads S80.X) }
      - { q: R, set: TIC213:TIC213.SP_EXT_ON }
    time: { max: 40min }
  S70:
    description: Stop agitator
    sheet: 2
    actions:
      - { q: R, set: M216:M216.START }
    time: { max: 30s }

transitions:
  - { from: S0, to: S10, condition: START_CMD and LIC210:LS210E.LT and not LI221:LAL221.QL, comment: Tank empty and caustic available }
  - { from: S10, to: [S20, S25], condition: LIC210:LS210A.GT, comment: Blades covered }
  - { from: S20, to: S22, condition: FIC211:FQ211.OUT >= 8, comment: Batch quantity 8 m3 }
  - { from: S25, to: S27, condition: M216:M216.RUNNING }
  - { from: [S22, S27], to: S30, condition: S22.T > 10s, comment: Inlet valve closed }
  - { from: S30, to: S40, condition: TIC213:TT213.PV >= 64 }
  - { from: S40, to: S50, condition: AIC215:AIC215.ER > -0.2 and AIC215:AIC215.ER < 0.2 and S40.T >= 5min, comment: pH 7.0 ± 0.2 }
  - { from: S50, to: S60, condition: LAB_OK and S50.T >= 30min }
  - { from: S50, to: S80, condition: LAB_REJECT }
  - { from: S60, to: S70, condition: LIC210:LS210E.LT }
  - { from: S80, to: S70, condition: LIC210:LS210E.LT }
  - { from: S70, to: S0, condition: not M216:M216.RUNNING }

notes:
  - text: Parallel branch — the agitator starts as soon as its blades are covered while filling continues.
  - text: Alternative branch — the laboratory releases (S60) or rejects (S80) the batch.
    sheet: 2
`;

const BATCH_T210_MD = `## Function

Batch preparation in the mixing tank T210 (ISA-88 *procedure* of unit U210).

| Step | Description | Equipment |
|------|-------------|-----------|
| S10 | Fill water until the agitator blades are covered | FIC211 cascade, FQ211 reset |
| S20 ∥ S25 | Continue filling with ratio dosing of caustic ∥ start agitator | FFIC214 / XV214 ∥ M216 |
| S22 | Stop filling at 8 m³ | FIC211, XV214 |
| S30 | Heat to 65 °C | TIC213 split range |
| S40 | Adjust pH to 7.0 ± 0.2 | AIC215 |
| S50 | Hold at least 30 min, laboratory sample after 15 min | AIC215 manual 0 % |
| S60 / S80 | Transfer to storage / drain to waste | XV217 / XV218 |
| S70 | Stop agitator | M216 |

The batch only starts when the tank is empty and the caustic tank is not low.

\`\`\`chart
type: step
title: Typical batch — temperature setpoint
x: { label: "Time [min]", min: 0, max: 180 }
y: { label: "TIC213 setpoint [°C]", min: 0, max: 80 }
series:
  - { name: SP, points: [[0, 20], [35, 65], [150, 20], [180, 20]] }
\`\`\`
`;

// ---------------------------------------------------------------------------
// Area Dosing — U220 Chemical store
// ---------------------------------------------------------------------------

const LI221 = `format: csd-strategy/1
uid: ${uid(30)}
strategy: LI221
title: Chemical store tank levels
description: Volume and level alarms of the caustic tank T221 and the acid tank T222.
scan: 2s

sheets:
  - { id: 1, title: Caustic tank T221 }
  - { id: 2, title: Acid tank T222 }
  - { id: 3, title: Alarms }

blocks:
  LT221:
    type: AI
    description: T221 caustic level
    order: 10
    params: { CHANNEL: LT221, PV_HI: 2.5, UNIT: m }
  VT221:
    type: acme/TANK_VOL
    description: T221 volume
    order: 20
    params: { DIAM: 1.6, H_CONE: 0.3, H_TOTAL: 2.4 }
  LAL221:
    type: LIM_ALM
    description: T221 filling limits (%)
    order: 30
    params: { H: 90, L: 15, HYST: 1, DELAY: 5s }
  LT222:
    type: AI
    description: T222 acid level
    sheet: 2
    order: 40
    params: { CHANNEL: LT222, PV_HI: 2.0, UNIT: m }
  VT222:
    type: acme/TANK_VOL
    description: T222 volume
    sheet: 2
    order: 50
    params: { DIAM: 1.2, H_CONE: 0.25, H_TOTAL: 1.9 }
  LAL222:
    type: LIM_ALM
    description: T222 filling limits (%)
    sheet: 2
    order: 60
    params: { H: 90, L: 15, HYST: 1, DELAY: 5s }
  XA220:
    type: OR
    description: Chemical store common alarm
    sheet: 3
    order: 70
  XA220_DO:
    type: DO
    description: Alarm beacon chemical store
    sheet: 3
    order: 80
    params: { CHANNEL: XA220 }

links:
  - LT221.PV -> VT221.LEVEL
  - VT221.PCT -> LAL221.IN
  - LT222.PV -> VT222.LEVEL
  - VT222.PCT -> LAL222.IN
  - from: LAL221.QH
    to: XA220.IN1
    label: LAH221
    category: alarm
  - from: LAL221.QL
    to: XA220.IN2
    label: LAL221
    category: alarm
  - from: LAL222.QH
    to: XA220.IN3
    label: LAH222
    category: alarm
  - from: LAL222.QL
    to: XA220.IN4
    label: LAL222
    category: alarm
  - XA220.OUT -> XA220_DO.IN

notes:
  - text: Volumes VT221 / VT222 are shown on the HMI and used for the chemical consumption report.
`;

const LI221_MD = `## Function

The levels of the chemical tanks are converted to volume and filling degree
with the company block \`acme/TANK_VOL\` (vertical tank with conical bottom).
The alarm limits are set in **% of the volume**, so they do not depend on the
tank geometry.

| Tank | Medium | Diameter | Cone | Volume at 100 % |
|------|--------|----------|------|-----------------|
| T221 | Caustic soda 30 % | 1.6 m | 0.3 m | 4.4 m³ |
| T222 | Sulphuric acid 37 % | 1.2 m | 0.25 m | 1.9 m³ |

The *low* alarms are interlocks of the dosing: LAL221 closes the caustic valve
XV214 (FFIC214) and stops the CIP caustic dosing (QIC313); LAL222 stops the
acid pump of AIC215. The batch sequence does not start with a low caustic
tank.
`;

// ---------------------------------------------------------------------------
// Area CIP — U310 CIP station
// ---------------------------------------------------------------------------

const FIC311 = `format: csd-strategy/1
uid: ${uid(40)}
strategy: FIC311
title: CIP supply flow and pump P311
description: CIP supply pump with variable speed drive; the flow controller sets the speed.
scan: 500ms

sheets:
  - { id: 1, title: Supply flow }
  - { id: 2, title: Supply pump P311 }

blocks:
  FT311:
    type: AI
    description: CIP supply flow
    order: 10
    params: { CHANNEL: FT311, PV_HI: 40, UNIT: m3/h }
  FIC311:
    type: PID
    description: CIP supply flow controller
    order: 20
    params: { GAIN: 0.3, TI: 5s, SP_INT: 25, SP_HI: 35, PV_HI: 40, UNIT: m3/h, TRK_VAL: 0 }
    comment: Setpoint per CIP step from CIP_T210.
  SC311:
    type: AO
    description: P311 speed setpoint (VFD)
    order: 30
    params: { CHANNEL: SC311 }
  LSL310:
    type: DI
    description: T310 low level switch, inverted (TRUE = level OK)
    sheet: 2
    order: 40
    params: { CHANNEL: LSL310, INVERT: true }
  HS310:
    type: DI
    description: CIP emergency stop, inverted (TRUE = released)
    sheet: 2
    order: 42
    params: { CHANNEL: HS310_ESD, INVERT: true }
  P311_ILK:
    type: INTLK
    description: Pump interlock (dry run, emergency stop)
    sheet: 2
    order: 44
    pos: [300, 72]
  P311:
    type: MOTOR
    description: CIP supply pump
    sheet: 2
    order: 50
    params: { FB_TIME: 5s }
  P311_CMD:
    type: DO
    description: P311 starter (VFD enable)
    sheet: 2
    order: 60
    params: { CHANNEL: P311_CMD }
  P311_OFF:
    type: NOT
    description: Pump not running
    sheet: 2
    order: 70
  P311_FB:
    type: DI
    description: P311 running feedback
    sheet: 2
    order: 46
    params: { CHANNEL: P311_RUN }

links:
  - FT311.PV -> FIC311.PV
  - FIC311.MV -> SC311.IN
  - LSL310.OUT -> P311_ILK.IN1
  - HS310.OUT -> P311_ILK.IN2
  - from: P311_ILK.OUT
    to: P311.INTLK
    label: P311_ILK
    category: interlock
  - P311_FB.OUT -> P311.FB_RUN
  - P311.CMD -> P311_CMD.IN
  - P311.RUNNING -> P311_OFF.IN
  - from: P311_OFF.OUT
    to: FIC311.TRK_ON
    category: tracking
    comment: Speed 0 % while the pump is off
`;

const FIC311_MD = `## Function

The CIP supply pump P311 runs with a variable speed drive. The flow
controller FIC311 sets the speed; while the pump is stopped the controller
output tracks 0 % so the pump ramps up from standstill. The running signal
comes from sheet 2 and is read from the previous cycle (z⁻¹).

| CIP step | Flow setpoint | Written by |
|----------|---------------|------------|
| Pre-rinse | 20 m³/h, 30 m³/h for the first 2 min | CIP_T210 S10 |
| Caustic circulation | 30 m³/h | CIP_T210 S40 |
| Intermediate and final rinse | 25 m³/h (internal SP) | — |

The pump is interlocked by the low level switch LSL310 of the CIP tank T310
(dry running) and the emergency stop HS310 of the CIP station.
`;

const TIC312 = `format: csd-strategy/1
uid: ${uid(41)}
strategy: TIC312
title: CIP supply temperature
description: Steam heating of the CIP supply in the heat exchanger E310; steam blocked without flow.
scan: 1s

blocks:
  TT312:
    type: AI
    description: CIP supply temperature
    order: 10
    params: { CHANNEL: TT312, PV_HI: 100, UNIT: °C }
  NO_FLOW:
    type: CMP
    description: CIP flow below 5 m3/h
    order: 20
    params: { IN2: 5, HYST: 0.5 }
  TIC312:
    type: PID
    description: CIP temperature controller
    order: 30
    params: { GAIN: 2.0, TI: 60s, SP_INT: 20, SP_HI: 85, PV_HI: 100, UNIT: °C, TRK_VAL: 0 }
  TV312:
    type: AO
    description: Steam valve E310 (fail closed)
    order: 40
    params: { CHANNEL: TV312, FAIL_SAFE: MIN }
  TAH312:
    type: LIM_ALM
    description: CIP temperature limits
    order: 50
    params: { H: 88, L: 10, HYST: 0.5, DELAY: 5s }
  XA310:
    type: OR
    description: CIP station common alarm
    order: 60
  XA310_DO:
    type: DO
    description: Alarm beacon CIP
    order: 70
    params: { CHANNEL: XA310 }

links:
  - TT312.PV -> TIC312.PV
  - from: FIC311:FT311.PV
    to: NO_FLOW.IN1
    comment: CIP supply flow
  - from: NO_FLOW.LT
    to: TIC312.TRK_ON
    label: TV312_ILK
    category: interlock
    comment: Steam closed without flow
  - TIC312.MV -> TV312.IN
  - TT312.PV -> TAH312.IN
  - from: TAH312.QH
    to: XA310.IN1
    label: TAH312
    category: alarm
  - from: TAH312.QL
    to: XA310.IN2
    label: TAL312
    category: alarm
  - XA310.OUT -> XA310_DO.IN
`;

const TIC312_MD = `## Function

The CIP supply is heated with steam in the heat exchanger E310. The setpoint
(75 °C for the caustic steps) is written by the CIP sequence; the steam valve
starts 30 s after the setpoint (\`D\` action in CIP_T210 S35).

Without CIP flow (FT311 below 5 m³/h) the controller output tracks 0 % and
the steam valve stays closed, so the exchanger cannot boil dry.

| Alarm | Limit | Delay |
|-------|-------|-------|
| TAH312 | 88 °C | 5 s |
| TAL312 | 10 °C | 5 s |
`;

const QIC313 = `format: csd-strategy/1
uid: ${uid(42)}
strategy: QIC313
title: CIP caustic concentration
description: Conductivity control of the CIP caustic solution by dosing caustic from T221.
scan: 1s

blocks:
  QT313:
    type: AI
    description: CIP conductivity
    order: 10
    params: { CHANNEL: QT313, PV_HI: 200, UNIT: mS/cm, FILTER_T: 5s }
  CAUSTIC_STEP:
    type: OR
    description: CIP in a caustic step
    order: 20
  T221_OK:
    type: NOT
    description: Caustic tank not low
    order: 30
  DOSE_PERM:
    type: AND
    description: Dosing permitted
    order: 40
  NO_DOSE:
    type: NOT
    description: Pump stopped outside caustic steps
    order: 50
  QIC313:
    type: PID
    description: Conductivity controller
    order: 60
    params: { GAIN: 0.8, TI: 45s, SP_INT: 80, SP_HI: 120, PV_HI: 200, UNIT: mS/cm, TRK_VAL: 0 }
    comment: 80 mS/cm ≈ 2 % NaOH at 75 °C.
  SC313:
    type: AO
    description: Caustic dosing pump P313 speed
    order: 70
    params: { CHANNEL: SC313 }

links:
  - QT313.PV -> QIC313.PV
  - from: CIP_T210:S30.X
    to: CAUSTIC_STEP.IN1
    comment: Dose caustic
  - from: CIP_T210:S40.X
    to: CAUSTIC_STEP.IN2
    comment: Caustic circulation
  - LI221:LAL221.QL -> T221_OK.IN
  - CAUSTIC_STEP.OUT -> DOSE_PERM.IN1
  - from: T221_OK.OUT
    to: DOSE_PERM.IN2
    category: interlock
  - DOSE_PERM.OUT -> NO_DOSE.IN
  - from: NO_DOSE.OUT
    to: QIC313.TRK_ON
    category: tracking
  - QIC313.MV -> SC313.IN
`;

const QIC313_MD = `## Function

During the caustic steps of the CIP (S30 *Dose caustic* and S40 *Caustic
circulation*) the conductivity of the CIP solution is kept at **80 mS/cm**
(≈ 2 % NaOH at 75 °C) by dosing caustic from tank T221 with pump P313.

Outside these steps, or when T221 is low, the controller output tracks 0 %
and the pump stops. The steps are read directly from the sequence
(\`CIP_T210:S30.X\`, \`CIP_T210:S40.X\`).
`;

const CIP_T210 = `format: csd-sequence/1
uid: ${uid(43)}
sequence: CIP_T210
title: Clean-in-place of mixing tank T210
description: Pre-rinse, caustic cleaning at 75 °C, intermediate and final rinse of T210 and its lines.
scan: 1s

sheets:
  - { id: 1, title: Pre-rinse and preparation }
  - { id: 2, title: Cleaning and rinse }

inputs:
  - { name: CIP_REQ, type: BOOL, description: Operator requests CIP }
  - { name: ACK_CMD, type: BOOL, description: Operator acknowledges a CIP fault }

steps:
  S0:
    initial: true
    description: Idle
  S10:
    description: Pre-rinse with water
    actions:
      - { q: S, set: FIC311:P311.START }
      - { q: L, set: FIC311:FIC311.SP_EXT, value: 30, time: 2min }
      - { q: S, set: FIC311:FIC311.SP_EXT_ON }
    time: { max: 10min }
  S20:
    description: Drain pre-rinse water
    actions:
      - { q: N, set: FIC311:FIC311.SP_EXT, value: 20 }
    time: { max: 5min }
  S30:
    description: Dose caustic to 80 mS/cm
    actions:
      - { q: N, text: QIC313 doses caustic (reads S30.X) }
    time: { max: 15min }
  S35:
    description: Heat CIP supply to 75 °C
    actions:
      - { q: N, set: TIC312:TIC312.SP_EXT, value: 75 }
      - { q: D, set: TIC312:TIC312.SP_EXT_ON, time: 30s }
    time: { max: 20min }
  S40:
    description: Caustic circulation
    sheet: 2
    actions:
      - { q: N, set: FIC311:FIC311.SP_EXT, value: 30 }
      - { q: N, set: TIC312:TIC312.SP_EXT, value: 75 }
    time: { min: 20min, max: 40min }
  S50:
    description: Intermediate rinse
    sheet: 2
    actions:
      - { q: R, set: TIC312:TIC312.SP_EXT_ON }
      - { q: R, set: FIC311:FIC311.SP_EXT_ON }
    time: { max: 15min }
  S60:
    description: Final rinse to drain
    sheet: 2
    actions:
      - { q: N, text: Drain XV218 opens (XV217 reads S60.X) }
    time: { max: 10min }
  S70:
    description: Stop pump, CIP done
    sheet: 2
    actions:
      - { q: R, set: FIC311:P311.START }
      - { q: P1, text: "Print CIP report (times, temperatures, conductivity)" }
    time: { max: 5min }
  S90:
    description: CIP fault
    sheet: 2
    actions:
      - { q: R, set: FIC311:P311.START }
      - { q: R, set: TIC312:TIC312.SP_EXT_ON }
      - { q: N, text: Alarm "CIP temperature lost" to the operator }

transitions:
  - { from: S0, to: S10, condition: CIP_REQ and not BATCH_T210:SEQ.RUNNING and START_U110:S40.X, comment: Process water in operation }
  - { from: S10, to: S20, condition: S10.T >= 5min }
  - { from: S20, to: [S30, S35], condition: LIC210:LS210E.LT and S20.T > 30s, comment: Tank empty }
  - { from: [S30, S35], to: S40, condition: QIC313:QT313.PV >= 78 and TIC312:TT312.PV >= 74 }
  - { from: S40, to: S50, condition: S40.T >= 20min }
  - { from: S40, to: S90, condition: TIC312:TT312.PV < 65 and S40.T > 2min, comment: Temperature lost }
  - { from: S50, to: S60, condition: QIC313:QT313.PV < 5 and S50.T > 3min, comment: Caustic rinsed out }
  - { from: S60, to: S70, condition: S60.T >= 5min and QIC313:QT313.PV < 1, comment: Rinse water clean }
  - { from: S70, to: S0, condition: not FIC311:P311.RUNNING and LIC210:LS210E.LT }
  - { from: S90, to: S0, condition: ACK_CMD }
`;

const CIP_T210_MD = `## Function

Clean-in-place of the mixing tank T210 and its supply lines from the CIP
station U310. The CIP only starts when no batch is running in T210
(\`BATCH_T210:SEQ.RUNNING\`) and the process water supply is in operation
(\`START_U110:S40.X\`).

| Step | Description | Flow | Temperature | Typical time |
|------|-------------|------|-------------|--------------|
| S10 | Pre-rinse with water | 30 → 20 m³/h | ambient | 5 min |
| S20 | Drain | 20 m³/h | ambient | 2 min |
| S30 ∥ S35 | Dose caustic ∥ heat | 20 m³/h | → 75 °C | 10 min |
| S40 | Caustic circulation | 30 m³/h | 75 °C | 20 min |
| S50 | Intermediate rinse | 25 m³/h | ambient | 5 min |
| S60 | Final rinse to drain | 25 m³/h | ambient | 5 min |
| S70 | Stop pump, CIP report | — | — | 1 min |

While the CIP runs the product outlet XV217 is interlocked; the drain XV218
opens in steps S20 and S60.

\`\`\`chart
type: bar
title: CIP step durations
categories: [Pre-rinse, Drain, Dose/heat, Caustic, Rinse, Final]
y: { label: "Time [min]" }
series:
  - { name: Typical, values: [5, 2, 10, 20, 5, 5] }
  - { name: Maximum, values: [10, 5, 20, 40, 15, 10] }
\`\`\`

If the supply temperature drops below 65 °C during the caustic circulation,
the CIP is aborted (S90) and has to be restarted after the operator
acknowledged the fault.
`;

// ---------------------------------------------------------------------------

export function dosingCipProjectFiles(): Files {
  return {
    'project.yaml': PROJECT,
    'README.md': README,
    'assets/plant-overview.svg': OVERVIEW_SVG,
    'assets/t210.svg': T210_SVG,
    ...stdLibraryFiles(),
    'library/acme/library.yaml': LIB,
    'library/acme/DUTY_STANDBY@1.0.0.yaml': DUTY_STANDBY,
    'library/acme/AI_2OO3@1.0.0.yaml': AI_2OO3,
    'library/acme/TANK_VOL@1.0.0.yaml': TANK_VOL,

    'strategies/ACME/README.md': `# ACME Chemicals

Enterprise level. Company blocks are maintained in the library \`acme\` and
shared by all ACME sites.
`,
    [`${SITE}/README.md`]: `# Ostrava site

Batch mixing plant with its own process water supply, chemical store and CIP
station. Scan times: 500 ms for flow and devices, 1 s for level, temperature
and analysers, 2 s for tank inventory.
`,
    [`${UTIL}/README.md`]: `# Utilities

Process water supply for the mixing tank and the CIP station.
`,
    [`${U110}/README.md`]: `# U110 — Process water

Tank T110 with the duty / standby pumps P111A / P111B and the header pressure
control PIC112 (recirculation to T110).

| Tag | Equipment |
|-----|-----------|
| T110 | Process water tank 20 m³ |
| P111A / P111B | Centrifugal pumps 15 m³/h at 5 bar |
| PV112 | Recirculation control valve |
`,
    [`${U110}/P111.yaml`]: P111,
    [`${U110}/P111.md`]: P111_MD,
    [`${U110}/PIC112.yaml`]: PIC112,
    [`${U110}/PIC112.md`]: PIC112_MD,
    [`${U110}/START_U110.seq.yaml`]: START_U110,
    [`${U110}/START_U110.md`]: START_U110_MD,

    [`${DOS}/README.md`]: `# Dosing

Batch mixing tank T210 and the chemical store with caustic and acid.
`,
    [`${U210}/README.md`]: `# U210 — Mixing tank T210

Jacketed tank of 12 m³ with agitator, water inlet, caustic and acid dosing.

![T210 sketch](assets/t210.svg)

| Function | Strategy |
|----------|----------|
| Level (master) | LIC210 |
| Water inlet (slave) and totaliser | FIC211 |
| Temperature, split range steam / cooling | TIC213 |
| Caustic ratio dosing | FFIC214 |
| pH control with feed-forward | AIC215 |
| Agitator | M216 |
| Outlet and drain valves | XV217 |
| Batch procedure | BATCH_T210 |
`,
    [`${U210}/LIC210.yaml`]: LIC210,
    [`${U210}/LIC210.md`]: LIC210_MD,
    [`${U210}/FIC211.yaml`]: FIC211,
    [`${U210}/FIC211.md`]: FIC211_MD,
    [`${U210}/TIC213.yaml`]: TIC213,
    [`${U210}/TIC213.md`]: TIC213_MD,
    [`${U210}/FFIC214.yaml`]: FFIC214,
    [`${U210}/FFIC214.md`]: FFIC214_MD,
    [`${U210}/AIC215.yaml`]: AIC215,
    [`${U210}/AIC215.md`]: AIC215_MD,
    [`${U210}/M216.yaml`]: M216,
    [`${U210}/M216.md`]: M216_MD,
    [`${U210}/XV217.yaml`]: XV217,
    [`${U210}/XV217.md`]: XV217_MD,
    [`${U210}/BATCH_T210.seq.yaml`]: BATCH_T210,
    [`${U210}/BATCH_T210.md`]: BATCH_T210_MD,

    [`${U220}/README.md`]: `# U220 — Chemical store

Caustic tank T221 and acid tank T222 with level measurement. The tanks are
filled from road tankers; filling is not automated.

\`\`\`chart
type: bar
title: Chemical consumption per batch
categories: [Caustic T221, Acid T222]
y: { label: "Volume [l]" }
series:
  - { name: Batch, values: [200, 45] }
  - { name: CIP, values: [120, 0] }
\`\`\`
`,
    [`${U220}/LI221.yaml`]: LI221,
    [`${U220}/LI221.md`]: LI221_MD,

    [`${CIP}/README.md`]: `# CIP

Clean-in-place station for the mixing tank.
`,
    [`${U310}/README.md`]: `# U310 — CIP station

CIP tank T310, supply pump P311 with variable speed drive, steam heat
exchanger E310 and caustic dosing pump P313 from the chemical store.
`,
    [`${U310}/FIC311.yaml`]: FIC311,
    [`${U310}/FIC311.md`]: FIC311_MD,
    [`${U310}/TIC312.yaml`]: TIC312,
    [`${U310}/TIC312.md`]: TIC312_MD,
    [`${U310}/QIC313.yaml`]: QIC313,
    [`${U310}/QIC313.md`]: QIC313_MD,
    [`${U310}/CIP_T210.seq.yaml`]: CIP_T210,
    [`${U310}/CIP_T210.md`]: CIP_T210_MD,
  };
}
