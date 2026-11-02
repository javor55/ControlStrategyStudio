// Writes the JSON Schemas of all file kinds to schema/ (the published format contract).
// Usage: npm run schemas
import { mkdirSync, writeFileSync } from 'node:fs';
import { CURRENT_FORMAT, SCHEMAS } from '@csd/core';

mkdirSync('schema', { recursive: true });
for (const [kind, schema] of Object.entries(SCHEMAS)) {
  const file = `schema/${kind}-${CURRENT_FORMAT[kind as keyof typeof CURRENT_FORMAT]}.json`;
  writeFileSync(file, JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...schema }, null, 2) + '\n');
  console.log(file);
}
