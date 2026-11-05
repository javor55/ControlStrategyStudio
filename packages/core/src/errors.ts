// Errors raised by operations.

/**
 * Stable, machine-readable reasons an operation was refused. Integrations may
 * rely on these; the message is for people and may change.
 *
 *   not-found     the file, block, step, port, sheet … does not exist
 *   exists        the new name / file is already taken
 *   invalid-name  the name does not follow the naming rules
 *   reserved      the name is reserved (`in`, `out`, `SEQ`, `README` …)
 *   syntax        the file has a YAML syntax error; fix it in the text editor first
 *   not-empty     the item still contains something (e.g. a sheet with blocks)
 *   wrong-file    the op does not apply to this kind of file
 *   invalid       anything else that makes the op invalid
 */
export type OpErrorCode = 'not-found' | 'exists' | 'invalid-name' | 'reserved' | 'syntax' | 'not-empty' | 'wrong-file' | 'invalid';

export class OpError extends Error {
  readonly code: OpErrorCode;
  constructor(message: string, code: OpErrorCode = 'invalid') {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}
