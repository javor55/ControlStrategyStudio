// JSON Schemas of all CSD file kinds. They are the formal, published contract
// of the format: the app validates with them and external systems can too.
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { DocKind } from './format';
import type { Diag } from './types';
import { lineAt, type ParsedYaml, type YamlPath } from './yamlutil';

export const IDENT = '^[A-Za-z_][A-Za-z0-9_]*$';
export const TAG = '^[A-Za-z_][A-Za-z0-9_-]*$';
export const SEMVER = '^\\d+\\.\\d+\\.\\d+$';

const ext = { patternProperties: { '^x-': {} } };
const text = { type: 'string' };
const pos = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

const wireStyle = {
  type: 'object',
  properties: { color: { type: 'string' }, style: { enum: ['solid', 'dashed', 'dotted', 'dashdot'] }, width: { type: 'number', minimum: 0.5, maximum: 6 } },
  additionalProperties: false,
};

const portDef = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', pattern: IDENT },
    type: { type: 'string', pattern: IDENT },
    description: text,
    default: {},
    unit: text,
    values: { type: 'array', items: { type: 'string' } },
    visibility: { enum: ['always', 'connected'] },
  },
  ...ext,
  additionalProperties: false,
};

const blockInst = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string' },
    description: text,
    doc: text,
    comment: text,
    scan: text,
    order: { type: 'integer' },
    sheet: { type: 'integer', minimum: 1 },
    params: { type: ['object', 'null'] },
    pos,
    display: { type: 'object', properties: { params: { type: 'boolean' } }, additionalProperties: false },
  },
  ...ext,
  additionalProperties: false,
};

const link = {
  type: ['string', 'object'],
  if: { type: 'object' },
  then: {
    required: ['from', 'to'],
    properties: { from: text, to: text, comment: text, label: text, category: { type: 'string', pattern: TAG } },
    ...ext,
    additionalProperties: false,
  },
};

const note = {
  type: 'object',
  required: ['text'],
  properties: { text, sheet: { type: 'integer', minimum: 1 }, pos, width: { type: 'number' } },
  ...ext,
  additionalProperties: false,
};

const sheet = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 }, title: text },
  ...ext,
  additionalProperties: false,
};

const diagramProps = {
  sheets: { type: ['array', 'null'], items: sheet },
  blocks: { type: ['object', 'null'], propertyNames: { pattern: TAG }, additionalProperties: blockInst },
  links: { type: ['array', 'null'], items: link },
  notes: { type: ['array', 'null'], items: note },
};

export const SCHEMAS: Record<DocKind, object> = {
  project: {
    $id: 'https://csd.studio/schema/project-1.json',
    type: 'object',
    required: ['name'],
    properties: {
      format: text,
      uid: text,
      name: text,
      description: text,
      author: text,
      levels: { type: 'array', items: { type: 'string' } },
      drawing: {
        type: 'object',
        properties: {
          signals: {
            type: 'object',
            properties: Object.fromEntries(['bool', 'real', 'other'].map((k) => [k, wireStyle])),
            additionalProperties: false,
          },
          feedback: {
            type: 'object',
            properties: { mark: { type: 'boolean' }, style: { enum: ['solid', 'dashed', 'dotted', 'dashdot', 'same'] }, color: text },
            additionalProperties: false,
          },
          params: { enum: ['show', 'hide'] },
        },
        ...ext,
        additionalProperties: false,
      },
      signal_categories: {
        type: 'object',
        propertyNames: { pattern: TAG },
        additionalProperties: {
          type: 'object',
          properties: {
            color: text,
            style: { enum: ['solid', 'dashed', 'dotted', 'dashdot'] },
            width: { type: 'number', minimum: 0.5, maximum: 6 },
            description: text,
          },
          ...ext,
          additionalProperties: false,
        },
      },
      title_block: {
        type: 'object',
        properties: { logo: text, drawn: text, checked: text, approved: text },
        ...ext,
        additionalProperties: false,
      },
    },
    ...ext,
    additionalProperties: false,
  },
  library: {
    $id: 'https://csd.studio/schema/library-1.json',
    type: 'object',
    required: ['name'],
    properties: {
      format: text,
      uid: text,
      name: text,
      version: { type: 'string', pattern: SEMVER },
      description: text,
    },
    ...ext,
    additionalProperties: false,
  },
  blocktype: {
    $id: 'https://csd.studio/schema/blocktype-1.json',
    type: 'object',
    required: ['type', 'version'],
    properties: {
      format: text,
      uid: text,
      type: { type: 'string', pattern: IDENT },
      version: { type: 'string', pattern: SEMVER },
      category: text,
      description: text,
      color: text,
      kind: { enum: ['basic', 'composite'] },
      inputs: { type: ['array', 'null'], items: portDef },
      outputs: { type: ['array', 'null'], items: portDef },
      params: { type: ['array', 'null'], items: portDef },
      implementation: {
        type: 'object',
        properties: { language: text, source: text },
        ...ext,
        additionalProperties: false,
      },
      diagram: { type: 'object', properties: diagramProps, additionalProperties: false },
    },
    ...ext,
    additionalProperties: false,
  },
  strategy: {
    $id: 'https://csd.studio/schema/strategy-1.json',
    type: 'object',
    required: ['strategy'],
    properties: {
      format: text,
      uid: text,
      strategy: { type: 'string', pattern: TAG },
      title: text,
      description: text,
      revision: text,
      author: text,
      scan: text,
      ...diagramProps,
    },
    ...ext,
    additionalProperties: false,
  },
};

let ajv: Ajv | undefined;
const validators = new Map<DocKind, ValidateFunction>();

function validator(kind: DocKind): ValidateFunction {
  let v = validators.get(kind);
  if (!v) {
    ajv ??= new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    v = ajv.compile(SCHEMAS[kind]);
    validators.set(kind, v);
  }
  return v;
}

function pointerToPath(ptr: string): YamlPath {
  if (!ptr) return [];
  return ptr
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function toDiag(e: ErrorObject, file: string, parsed: ParsedYaml): Diag | undefined {
  const path = pointerToPath(e.instancePath);
  const where = path.length ? path.join('.') : '(root)';
  switch (e.keyword) {
    case 'if':
      return undefined; // reported by the nested `then` errors
    case 'additionalProperties': {
      const key = (e.params as { additionalProperty: string }).additionalProperty;
      return {
        severity: 'warning',
        code: 'unknown-key',
        message: `Unknown key "${key}" in ${where} (use an "x-" prefix for custom data)`,
        file,
        line: lineAt(parsed, [...path, key]),
      };
    }
    case 'required': {
      const key = (e.params as { missingProperty: string }).missingProperty;
      return { severity: 'error', code: 'missing-key', message: `Missing "${key}" in ${where}`, file, line: lineAt(parsed, path) };
    }
    case 'propertyNames':
      return undefined; // the nested pattern error is clearer
    case 'pattern':
      if (e.propertyName !== undefined || /propertyName/.test(e.schemaPath)) {
        return {
          severity: 'error',
          code: 'bad-name',
          message: `Invalid name "${e.propertyName ?? path[path.length - 1]}" — use letters, digits, "_" or "-"`,
          file,
          line: lineAt(parsed, path),
        };
      }
      return { severity: 'error', code: 'bad-value', message: `${where} ${e.message}`, file, line: lineAt(parsed, path) };
    default:
      return {
        severity: 'error',
        code: e.keyword === 'type' ? 'bad-type' : 'schema',
        message: `${where} ${e.message}`,
        file,
        line: lineAt(parsed, path),
      };
  }
}

/** Validates parsed YAML data against the schema of `kind`. */
export function validateSchema(kind: DocKind, parsed: ParsedYaml, file: string): Diag[] {
  const v = validator(kind);
  if (v(parsed.data)) return [];
  const out: Diag[] = [];
  const seen = new Set<string>();
  for (const e of v.errors ?? []) {
    const d = toDiag(e, file, parsed);
    if (!d) continue;
    const key = `${d.code}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
