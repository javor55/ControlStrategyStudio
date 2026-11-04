// Demo project: raw water intake with a level / flow cascade and a pump
// with dry-run protection. Used for first start, tests and documentation.
import { stdLibraryFiles } from './stdlib';
import type { Files } from './types';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';

export function demoProjectFiles(): Files {
  return {
    'project.yaml': `format: csd-project/1
uid: 0b6f2d8e-51a4-4c3e-8f0d-9e7a1c2b3d44
name: Water Treatment Brno
description: Control strategies for raw water intake, line 1
author: Process Engineering
levels:
  - Enterprise
  - Site
  - Area
  - Unit
  - Equipment Module
  - Control Module
title_block:
  drawn: Process Engineering
  checked: ""
  approved: ""
signal_categories:
  interlock: { color: "#b3261e", style: dashed, description: Safety and process interlocks }
  tracking: { color: "#6b7280", style: dotted, description: Output tracking and readbacks }
`,
    'README.md': `# Water Treatment Brno

Control strategies for the raw water intake of line 1. The intake unit U100
keeps tank T100 at its level setpoint by adjusting the inlet flow, and protects
the feed pump P101 against dry running.

All strategies are system independent. Block types come from the standard
library \`std\` and the company library \`acme\`.
`,
    ...stdLibraryFiles(),
    'library/acme/library.yaml': `format: csd-library/1
uid: 6e1c8a4b-2f0d-4b7a-9c3e-1d5f7a9b0c21
name: ACME company blocks
version: 1.0.0
description: Company-specific composite blocks shared across plants.
`,
    'library/acme/AI_2OO3@1.0.0.yaml': `format: csd-blocktype/1
uid: 3f9b2c71-8d4e-4a10-b6c5-7e2d9f0a1b34
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
  - { name: DEV_LIM, type: REAL, default: 2.0, description: Allowed spread }
diagram:
  blocks:
    TT_A: { type: AI, params: { CHANNEL: $CH_A, PV_HI: $PV_HI } }
    TT_B: { type: AI, params: { CHANNEL: $CH_B, PV_HI: $PV_HI } }
    TT_C: { type: AI, params: { CHANNEL: $CH_C, PV_HI: $PV_HI } }
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
`,
    'strategies/ACME/Brno/WaterTreatment/README.md': `# Water Treatment

Raw water intake, filtration and treated water storage.
`,
    [`${U100}/README.md`]: `# U100 — Raw water intake

Tank T100 with inlet control valve FV101 and feed pump P101.
`,
    [`${U100}/FIC101.yaml`]: `format: csd-strategy/1
uid: 4c1e9a52-0d7b-4f61-9a0e-2b8f3d61c7aa
strategy: FIC101
title: Inlet water flow control
description: Flow control of raw water inlet to tank T100. SP cascaded from LIC100.
scan: 500ms

blocks:
  FT101:
    type: AI
    description: Inlet flow transmitter
    doc: Measures raw water flow into T100, range 0–50 m3/h.
    order: 10
    params: { CHANNEL: FT101, PV_HI: 50, UNIT: m3/h }
  FIC101:
    type: PID@1.0.0
    description: Inlet flow controller
    doc: Slave controller of the level cascade. Follows the external setpoint from LIC100.
    order: 20
    params: { GAIN: 0.8, TI: 12s, SP_HI: 45, PV_HI: 50, UNIT: m3/h, SP_EXT_ON: true }
    comment: Tuning from loop test during FAT.
  FV101:
    type: AO
    description: Inlet control valve
    order: 30
    scan: 100ms
    params: { CHANNEL: FV101 }

links:
  - FT101.PV -> FIC101.PV
  - from: LIC100:LIC100.MV
    to: FIC101.SP_EXT
    comment: Cascade SP
  - FIC101.MV -> FV101.IN
  - from: FV101.OUT_RB
    to: FIC101.TRK_VAL
    category: tracking
    comment: Bumpless return from manual

notes:
  - text: Valve fails closed on loss of air (ATC).
`,
    [`${U100}/FIC101.md`]: `## Function

Keeps the inlet flow at the setpoint requested by level controller **LIC100**
(cascade slave). The valve FV101 fails closed on loss of instrument air.

## Operating modes

| Mode    | Setpoint source   |
|---------|-------------------|
| Cascade | LIC100.MV         |
| Auto    | Operator          |
| Manual  | Valve set by hand |
`,
    [`${U100}/LIC100.yaml`]: `format: csd-strategy/1
uid: 9a3d7e10-6b2c-4f8e-a1d0-5c7b9e2f4a63
strategy: LIC100
title: Tank T100 level control
description: Master controller of the inlet cascade with redundant level measurement.
scan: 1s

blocks:
  LT100:
    type: acme/AI_2OO3
    description: T100 level, 2oo3 transmitters
    order: 10
    params: { CH_A: LT100A, CH_B: LT100B, CH_C: LT100C, PV_HI: 4.0, DEV_LIM: 0.1 }
  LAL100:
    type: LIM_ALM
    description: T100 level limits
    order: 20
    params: { H: 3.6, L: 0.6, HYST: 0.05, DELAY: 2s }
  LIC100:
    type: PID
    description: T100 level controller
    order: 30
    params: { GAIN: 2.0, TI: 300s, SP_INT: 2.5, PV_HI: 4.0, UNIT: m, MV_HI: 45 }
    comment: MV is the flow setpoint for FIC101 in m3/h.

links:
  - LT100.PV -> LIC100.PV
  - LT100.PV -> LAL100.IN
`,
    [`${U100}/FILL_T100.seq.yaml`]: `format: csd-sequence/1
uid: 5d2e8c41-7a90-4b3f-9e16-0c4f2a8b6d17
sequence: FILL_T100
title: First filling of tank T100
description: Fills T100 from empty to the operating level, then starts the feed pump.
scan: 1s

inputs:
  - { name: START_CMD, type: BOOL, description: Operator start from the HMI }

steps:
  S0:
    initial: true
    description: Idle
  S10:
    description: Open inlet valve in manual
    actions:
      - { q: N, set: FIC101:FIC101.MAN_ON, value: true }
      - { q: N, set: FIC101:FIC101.MAN_VAL, value: 30 }
    time: { max: 2min }
  S20:
    description: Fill to operating level
    actions:
      - { q: N, text: Inlet flow controller in cascade with LIC100 }
    time: { max: 2h }
  S25:
    description: Watch dry-run protection
    actions:
      - { q: N, text: Alarm to operator if LSL100 is active }
  S30:
    description: Start feed pump
    actions:
      - { q: S, set: P101:P101.START, value: true }
    time: { max: 30s }

transitions:
  - { from: S0, to: S10, condition: START_CMD and not LIC100:LAL100.QH }
  - { from: S10, to: [S20, S25], condition: FIC101:FT101.PV > 5, comment: Flow established }
  - { from: [S20, S25], to: S30, condition: LIC100:LT100.PV >= 2.5, comment: Operating level }
  - { from: S30, to: S0, condition: P101:P101.RUNNING }
`,
    [`${U100}/FILL_T100.md`]: `## Function

First filling of tank T100 after maintenance. The inlet valve is opened in
manual until flow is established, then the level controller takes over. When
the operating level is reached the feed pump P101 is started.
`,
    [`${U100}/P101.yaml`]: `format: csd-strategy/1
uid: c2b7f4e9-1a3d-4e6b-8f0c-9d2a5b7e1f30
strategy: P101
title: Feed pump P101
description: Feed pump with dry-run protection from tank T100 low level.
scan: 500ms

sheets:
  - { id: 1, title: Pump control }
  - { id: 2, title: Dry-run protection }

blocks:
  P101:
    type: MOTOR
    description: Feed pump P101
    order: 50
    params: { FB_TIME: 5s }
  P101_FB:
    type: DI
    description: Pump running feedback
    order: 40
    params: { CHANNEL: P101_RUN }
  P101_CMD:
    type: DO
    description: Pump starter command
    order: 60
    params: { CHANNEL: P101_CMD }
  LSL100:
    type: DI
    description: T100 low level switch (TRUE = low)
    sheet: 2
    order: 10
    params: { CHANNEL: LSL100 }
  DRY_RUN:
    type: OR
    description: Dry-run condition
    sheet: 2
    order: 20
  HEALTHY:
    type: NOT
    description: Pump interlock healthy
    sheet: 2
    order: 30

links:
  - LSL100.OUT -> DRY_RUN.IN1
  - LIC100:LAL100.QL -> DRY_RUN.IN2
  - DRY_RUN.OUT -> HEALTHY.IN
  - from: HEALTHY.OUT
    to: P101.INTLK
    label: P101_ILK
    category: interlock
  - P101_FB.OUT -> P101.FB_RUN
  - P101.CMD -> P101_CMD.IN

notes:
  - text: START / STOP come from the operator faceplate (HMI).
`,
  };
}
