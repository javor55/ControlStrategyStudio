// Standard block library `std` 1.0.0.
// Defined compactly here; materialised as normal YAML files in `library/std/`
// so it can be read, edited, versioned and copied like any other library.
import { Document } from 'yaml';
import { formatTag } from './format';
import { blockTypeFile, libraryFile } from './paths';
import { stringifyDoc } from './yamlutil';

type P = { name: string; type: string; description?: string; default?: unknown; unit?: string; values?: string[] };
interface Def {
  type: string;
  category: string;
  description: string;
  inputs?: P[];
  outputs?: P[];
  params?: P[];
  implementation?: { language: string; source: string };
}

const p = (name: string, type: string, description?: string, extra: Partial<P> = {}): P => ({
  name,
  type,
  ...(description ? { description } : {}),
  ...extra,
});
const B = 'BOOL';
const R = 'REAL';
const T = 'TIME';
const S = 'STRING';
const I = 'INT';

const channel = p('CHANNEL', S, 'I/O address or tag', { default: '' });
const nIn = (n: number, type: string, desc?: string) => Array.from({ length: n }, (_, i) => p(`IN${i + 1}`, type, desc));

const DEFS: Def[] = [
  // ---------------------------------------------------------------- I/O
  {
    type: 'AI',
    category: 'I/O',
    description: 'Analog input channel with scaling, filter and limit alarms',
    inputs: [p('SIM_ON', B, 'Simulation active'), p('SIM_PV', R, 'Simulation value')],
    outputs: [p('PV', R, 'Scaled process value'), p('BAD', B, 'Bad quality'), p('HH', B, 'High-high alarm'), p('H', B, 'High alarm'), p('L', B, 'Low alarm'), p('LL', B, 'Low-low alarm')],
    params: [
      channel,
      p('PV_LO', R, 'Range low', { default: 0 }),
      p('PV_HI', R, 'Range high', { default: 100 }),
      p('UNIT', S, 'Engineering unit', { default: '%' }),
      p('FILTER_T', T, 'First-order filter time constant', { default: '0s' }),
      p('LIM_HH', R, 'High-high limit', { default: 95 }),
      p('LIM_H', R, 'High limit', { default: 90 }),
      p('LIM_L', R, 'Low limit', { default: 10 }),
      p('LIM_LL', R, 'Low-low limit', { default: 5 }),
      p('HYST', R, 'Alarm hysteresis', { default: 1 }),
    ],
  },
  {
    type: 'AO',
    category: 'I/O',
    description: 'Analog output channel',
    inputs: [p('IN', R, 'Output value'), p('SIM_ON', B, 'Simulation active')],
    outputs: [p('OUT_RB', R, 'Readback value'), p('BAD', B, 'Bad quality')],
    params: [channel, p('OUT_LO', R, 'Range low', { default: 0 }), p('OUT_HI', R, 'Range high', { default: 100 }), p('UNIT', S, 'Engineering unit', { default: '%' }), p('FAIL_SAFE', 'ENUM', 'Behaviour on fault', { default: 'HOLD', values: ['HOLD', 'MIN', 'MAX'] })],
  },
  {
    type: 'DI',
    category: 'I/O',
    description: 'Digital input channel',
    inputs: [p('SIM_ON', B, 'Simulation active'), p('SIM_VAL', B, 'Simulation value')],
    outputs: [p('OUT', B, 'Input state'), p('BAD', B, 'Bad quality')],
    params: [channel, p('INVERT', B, 'Invert signal', { default: false }), p('DEBOUNCE', T, 'Debounce time', { default: '0ms' })],
  },
  {
    type: 'DO',
    category: 'I/O',
    description: 'Digital output channel',
    inputs: [p('IN', B, 'Output command')],
    outputs: [p('FB', B, 'Readback'), p('BAD', B, 'Bad quality')],
    params: [channel, p('INVERT', B, 'Invert signal', { default: false }), p('FAIL_SAFE', 'ENUM', 'Behaviour on fault', { default: 'OFF', values: ['OFF', 'ON', 'HOLD'] })],
  },
  // ---------------------------------------------------------------- Logic
  { type: 'AND', category: 'Logic', description: 'Logical AND (unconnected inputs = TRUE)', inputs: nIn(4, B), outputs: [p('OUT', B)] },
  { type: 'OR', category: 'Logic', description: 'Logical OR (unconnected inputs = FALSE)', inputs: nIn(4, B), outputs: [p('OUT', B)] },
  { type: 'XOR', category: 'Logic', description: 'Exclusive OR', inputs: nIn(2, B), outputs: [p('OUT', B)] },
  { type: 'NOT', category: 'Logic', description: 'Inverter', inputs: [p('IN', B)], outputs: [p('OUT', B)] },
  { type: 'SR', category: 'Logic', description: 'Flip-flop, set dominant', inputs: [p('S1', B, 'Set (dominant)'), p('R', B, 'Reset')], outputs: [p('Q1', B)] },
  { type: 'RS', category: 'Logic', description: 'Flip-flop, reset dominant', inputs: [p('S', B, 'Set'), p('R1', B, 'Reset (dominant)')], outputs: [p('Q1', B)] },
  { type: 'R_TRIG', category: 'Logic', description: 'Rising edge detection', inputs: [p('CLK', B)], outputs: [p('Q', B, 'TRUE for one cycle on rising edge')] },
  { type: 'F_TRIG', category: 'Logic', description: 'Falling edge detection', inputs: [p('CLK', B)], outputs: [p('Q', B, 'TRUE for one cycle on falling edge')] },
  // ---------------------------------------------------------------- Timers
  { type: 'TON', category: 'Timers', description: 'On-delay timer', inputs: [p('IN', B)], outputs: [p('Q', B), p('ET', T, 'Elapsed time')], params: [p('PT', T, 'Preset time', { default: '5s' })] },
  { type: 'TOF', category: 'Timers', description: 'Off-delay timer', inputs: [p('IN', B)], outputs: [p('Q', B), p('ET', T, 'Elapsed time')], params: [p('PT', T, 'Preset time', { default: '5s' })] },
  { type: 'TP', category: 'Timers', description: 'Pulse timer', inputs: [p('IN', B)], outputs: [p('Q', B), p('ET', T, 'Elapsed time')], params: [p('PT', T, 'Pulse length', { default: '1s' })] },
  // ---------------------------------------------------------------- Compare
  {
    type: 'CMP',
    category: 'Compare',
    description: 'Comparator with hysteresis',
    inputs: [p('IN1', R), p('IN2', R)],
    outputs: [p('GT', B, 'IN1 > IN2'), p('GE', B, 'IN1 >= IN2'), p('EQ', B, 'IN1 = IN2'), p('LE', B, 'IN1 <= IN2'), p('LT', B, 'IN1 < IN2')],
    params: [p('HYST', R, 'Hysteresis', { default: 0 })],
  },
  {
    type: 'LIM_ALM',
    category: 'Compare',
    description: 'High / low limit alarm',
    inputs: [p('IN', R)],
    outputs: [p('QH', B, 'Above high limit'), p('QL', B, 'Below low limit')],
    params: [p('H', R, 'High limit', { default: 90 }), p('L', R, 'Low limit', { default: 10 }), p('HYST', R, 'Hysteresis', { default: 1 }), p('DELAY', T, 'Alarm delay', { default: '0s' })],
  },
  // ---------------------------------------------------------------- Math
  { type: 'ADD', category: 'Math', description: 'Addition', inputs: nIn(4, R), outputs: [p('OUT', R)] },
  { type: 'SUB', category: 'Math', description: 'Subtraction IN1 - IN2', inputs: nIn(2, R), outputs: [p('OUT', R)] },
  { type: 'MUL', category: 'Math', description: 'Multiplication', inputs: nIn(4, R), outputs: [p('OUT', R)] },
  { type: 'DIV', category: 'Math', description: 'Division IN1 / IN2', inputs: nIn(2, R), outputs: [p('OUT', R), p('ERR', B, 'Division by zero')] },
  { type: 'ABS', category: 'Math', description: 'Absolute value', inputs: [p('IN', R)], outputs: [p('OUT', R)] },
  {
    type: 'SCALE',
    category: 'Math',
    description: 'Linear scaling',
    inputs: [p('IN', R)],
    outputs: [p('OUT', R)],
    params: [p('IN_LO', R, '', { default: 0 }), p('IN_HI', R, '', { default: 100 }), p('OUT_LO', R, '', { default: 0 }), p('OUT_HI', R, '', { default: 100 })],
  },
  // ---------------------------------------------------------------- Select
  { type: 'SEL', category: 'Select', description: 'Binary selector: OUT = G ? IN1 : IN0', inputs: [p('G', B, 'Select'), p('IN0', R), p('IN1', R)], outputs: [p('OUT', R)] },
  { type: 'MAX', category: 'Select', description: 'High select', inputs: nIn(3, R), outputs: [p('OUT', R), p('IDX', I, 'Index of selected input')] },
  { type: 'MIN', category: 'Select', description: 'Low select', inputs: nIn(3, R), outputs: [p('OUT', R), p('IDX', I, 'Index of selected input')] },
  { type: 'MID', category: 'Select', description: 'Median of three (2oo3 measurement)', inputs: nIn(3, R), outputs: [p('OUT', R)] },
  { type: 'AVG', category: 'Select', description: 'Average of connected inputs', inputs: nIn(4, R), outputs: [p('OUT', R)] },
  // ---------------------------------------------------------------- Signal
  {
    type: 'LIMIT',
    category: 'Signal',
    description: 'Clamp value between limits',
    inputs: [p('IN', R)],
    outputs: [p('OUT', R), p('QH', B, 'At high limit'), p('QL', B, 'At low limit')],
    params: [p('MN', R, 'Low limit', { default: 0 }), p('MX', R, 'High limit', { default: 100 })],
  },
  {
    type: 'LAG',
    category: 'Signal',
    description: 'First-order filter',
    inputs: [p('IN', R)],
    outputs: [p('OUT', R)],
    params: [p('T', T, 'Time constant', { default: '10s' })],
    implementation: {
      language: 'SCL',
      source: [
        'FUNCTION_BLOCK LAG',
        'VAR_INPUT IN : REAL; END_VAR',
        'VAR_OUTPUT OUT : REAL; END_VAR',
        'VAR T : TIME := T#10s; CYCLE : TIME; END_VAR',
        '',
        'IF T > T#0s THEN',
        '  OUT := OUT + (IN - OUT) * TIME_TO_REAL(CYCLE) / TIME_TO_REAL(T + CYCLE);',
        'ELSE',
        '  OUT := IN;',
        'END_IF;',
        'END_FUNCTION_BLOCK',
        '',
      ].join('\n'),
    },
  },
  {
    type: 'LEADLAG',
    category: 'Signal',
    description: 'Lead-lag compensation',
    inputs: [p('IN', R)],
    outputs: [p('OUT', R)],
    params: [p('GAIN', R, '', { default: 1 }), p('T_LEAD', T, 'Lead time', { default: '0s' }), p('T_LAG', T, 'Lag time', { default: '10s' })],
  },
  {
    type: 'RAMP',
    category: 'Signal',
    description: 'Rate-of-change limiter',
    inputs: [p('IN', R), p('TRK_ON', B, 'Track input directly')],
    outputs: [p('OUT', R), p('ACTIVE', B, 'Ramping')],
    params: [p('UP_RATE', R, 'Max increase per second', { default: 1 }), p('DN_RATE', R, 'Max decrease per second', { default: 1 })],
  },
  { type: 'DEADBAND', category: 'Signal', description: 'Deadband around zero', inputs: [p('IN', R)], outputs: [p('OUT', R)], params: [p('DB', R, 'Deadband width', { default: 1 })] },
  {
    type: 'TOTAL',
    category: 'Signal',
    description: 'Totaliser (integrator)',
    inputs: [p('IN', R, 'Rate'), p('RESET', B), p('HOLD', B)],
    outputs: [p('OUT', R, 'Total')],
    params: [p('T_BASE', 'ENUM', 'Rate time base', { default: 'h', values: ['s', 'min', 'h'] }), p('UNIT', S, 'Unit of the total', { default: '' })],
  },
  // ---------------------------------------------------------------- Control
  {
    type: 'PID',
    category: 'Control',
    description: 'PID controller with external setpoint, manual and tracking',
    inputs: [
      p('PV', R, 'Process value'),
      p('SP_EXT', R, 'External setpoint (cascade)'),
      p('SP_EXT_ON', B, 'Use external setpoint', { default: false }),
      p('MAN_ON', B, 'Manual mode', { default: false }),
      p('MAN_VAL', R, 'Manual output value'),
      p('TRK_ON', B, 'Output tracking', { default: false }),
      p('TRK_VAL', R, 'Tracking value'),
      p('FF', R, 'Feed-forward'),
    ],
    outputs: [p('MV', R, 'Manipulated value'), p('SP', R, 'Active setpoint'), p('ER', R, 'Control error'), p('QH', B, 'MV at high limit'), p('QL', B, 'MV at low limit')],
    params: [
      p('GAIN', R, 'Proportional gain', { default: 1 }),
      p('TI', T, 'Integral time (0 = off)', { default: '30s' }),
      p('TD', T, 'Derivative time', { default: '0s' }),
      p('DIRECTION', 'ENUM', 'Control direction', { default: 'REVERSE', values: ['REVERSE', 'DIRECT'] }),
      p('SP_INT', R, 'Internal setpoint', { default: 50 }),
      p('SP_LO', R, 'Setpoint low limit', { default: 0 }),
      p('SP_HI', R, 'Setpoint high limit', { default: 100 }),
      p('MV_LO', R, 'Output low limit', { default: 0 }),
      p('MV_HI', R, 'Output high limit', { default: 100 }),
      p('PV_LO', R, 'PV range low', { default: 0 }),
      p('PV_HI', R, 'PV range high', { default: 100 }),
      p('UNIT', S, 'PV / SP unit', { default: '%' }),
      p('DEADBAND', R, 'Error deadband', { default: 0 }),
    ],
  },
  { type: 'RATIO', category: 'Control', description: 'Ratio station: OUT = IN * RATIO + BIAS', inputs: [p('IN', R)], outputs: [p('OUT', R)], params: [p('RATIO', R, '', { default: 1 }), p('BIAS', R, '', { default: 0 })] },
  {
    type: 'SPLIT',
    category: 'Control',
    description: 'Split range: OUT1 covers 0..SPLIT_PT, OUT2 covers SPLIT_PT..100',
    inputs: [p('IN', R, 'Controller output 0..100 %')],
    outputs: [p('OUT1', R), p('OUT2', R)],
    params: [p('SPLIT_PT', R, 'Split point', { default: 50, unit: '%' })],
  },
  // ---------------------------------------------------------------- Devices
  {
    type: 'MOTOR',
    category: 'Devices',
    description: 'Fixed-speed motor with interlock, permissive and feedback monitoring',
    inputs: [
      p('START', B, 'Start command (auto)'),
      p('STOP', B, 'Stop command (auto)'),
      p('INTLK', B, 'Interlock — FALSE trips the motor', { default: true }),
      p('PERM', B, 'Permissive to start', { default: true }),
      p('FB_RUN', B, 'Running feedback'),
      p('RESET', B, 'Fault reset'),
    ],
    outputs: [p('CMD', B, 'Run command to starter'), p('RUNNING', B), p('FAULT', B, 'Feedback or trip fault')],
    params: [p('FB_TIME', T, 'Feedback monitoring time', { default: '5s' }), p('MODE', 'ENUM', 'Mode after start-up', { default: 'AUTO', values: ['AUTO', 'MAN'] })],
  },
  {
    type: 'VALVE',
    category: 'Devices',
    description: 'On/off valve with interlock and end-position feedback',
    inputs: [p('OPEN', B, 'Open command (auto)'), p('INTLK', B, 'Interlock — FALSE forces fail position', { default: true }), p('FB_OPN', B, 'Open feedback'), p('FB_CLS', B, 'Closed feedback'), p('RESET', B, 'Fault reset')],
    outputs: [p('CMD', B, 'Command to solenoid'), p('OPENED', B), p('CLOSED', B), p('FAULT', B, 'Travel or position fault')],
    params: [p('TRAVEL_T', T, 'Max travel time', { default: '10s' }), p('FAIL_POS', 'ENUM', 'Position on interlock', { default: 'CLOSED', values: ['CLOSED', 'OPEN'] })],
  },
  {
    type: 'INTLK',
    category: 'Devices',
    description: 'Interlock summary with first-out (inputs TRUE = healthy)',
    inputs: [...nIn(4, B, 'Condition, TRUE = healthy'), p('RESET', B, 'Reset latched trip')],
    outputs: [p('OUT', B, 'TRUE = all healthy'), p('FIRST_OUT', I, 'Number of the first input that tripped')],
    params: [p('LATCH', B, 'Latch trip until reset', { default: true })],
  },
];

/**
 * Pins drawn only when linked or set to a constant (`visibility: connected`),
 * so everyday blocks stay compact. Everything stays available in the inspector.
 */
const CONNECTED_ONLY: Record<string, string[]> = {
  AI: ['SIM_ON', 'SIM_PV', 'BAD', 'HH', 'H', 'L', 'LL'],
  AO: ['SIM_ON', 'OUT_RB', 'BAD'],
  DI: ['SIM_ON', 'SIM_VAL', 'BAD'],
  DO: ['FB', 'BAD'],
  AND: ['IN3', 'IN4'],
  OR: ['IN3', 'IN4'],
  ADD: ['IN3', 'IN4'],
  MUL: ['IN3', 'IN4'],
  AVG: ['IN3', 'IN4'],
  MAX: ['IDX'],
  MIN: ['IDX'],
  DIV: ['ERR'],
  CMP: ['GE', 'EQ', 'LE'],
  TON: ['ET'],
  TOF: ['ET'],
  TP: ['ET'],
  LIMIT: ['QH', 'QL'],
  RAMP: ['TRK_ON', 'ACTIVE'],
  TOTAL: ['HOLD'],
  PID: ['MAN_ON', 'MAN_VAL', 'TRK_ON', 'TRK_VAL', 'FF', 'SP', 'ER', 'QH', 'QL'],
  MOTOR: ['RESET'],
  VALVE: ['RESET'],
  INTLK: ['IN3', 'IN4', 'FIRST_OUT'],
};

export const STD_LIBRARY = 'std';
export const STD_VERSION = '1.0.0';

/** Files of the standard library, ready to be placed into a project. */
export function stdLibraryFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  out[libraryFile(STD_LIBRARY)] = stringifyDoc(
    new Document({
      format: formatTag('library'),
      uid: 'a1d6c0de-0000-4000-8000-000000000001',
      name: 'CSD standard library',
      version: STD_VERSION,
      description: 'Common DCS function blocks: I/O, logic, timers, comparators, math, selectors, signal processing, control and devices.',
    }),
  );
  DEFS.forEach((d, i) => {
    const hide = new Set(CONNECTED_ONLY[d.type] ?? []);
    const vis = (ports: P[] | undefined) => (ports ?? []).map((p) => (hide.has(p.name) ? { ...p, visibility: 'connected' } : p));
    const data: Record<string, unknown> = {
      format: formatTag('blocktype'),
      uid: `a1d6c0de-0000-4000-8001-${String(i + 1).padStart(12, '0')}`,
      type: d.type,
      version: STD_VERSION,
      category: d.category,
      description: d.description,
      inputs: vis(d.inputs),
      outputs: vis(d.outputs),
      params: d.params ?? [],
    };
    if (d.implementation) data.implementation = d.implementation;
    const doc = new Document(data);
    // Compact one-line port definitions read best in a library file.
    for (const key of ['inputs', 'outputs', 'params']) {
      const seq = doc.get(key, true) as { items?: { flow?: boolean }[] } | undefined;
      seq?.items?.forEach((it) => (it.flow = true));
    }
    out[blockTypeFile(STD_LIBRARY, d.type, STD_VERSION)] = stringifyDoc(doc);
  });
  return out;
}
