import type { OperationContext } from '@mgravey/loom-plugin-api';

import {
  WORKSPACE_OPERATIONS,
  type ApplyPatchInput,
  type ApplyPatchOutput,
  type ApplyPatchTool,
  type TextWorkspace,
} from './contracts.js';
import { workspacePath } from './path.js';

export type StrictPatchErrorCode =
  'INVALID_PATCH' | 'MULTIPLE_FILES' | 'OVERLAPPING_HUNKS' | 'CONTEXT_MISMATCH';

export class StrictPatchError extends Error {
  readonly code: StrictPatchErrorCode;
  readonly hunk?: number;

  constructor(code: StrictPatchErrorCode, message: string, hunk?: number) {
    super(message);
    this.name = 'StrictPatchError';
    this.code = code;
    if (hunk !== undefined) this.hunk = hunk;
  }
}

interface PatchLine {
  readonly operation: 'context' | 'remove' | 'add';
  readonly content: string;
  readonly noNewline: boolean;
}

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

export interface StrictPatchResult {
  readonly content: string;
  readonly hunksApplied: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function invalid(message: string, hunk?: number): never {
  throw new StrictPatchError('INVALID_PATCH', message, hunk);
}

function parseCount(value: string | undefined): number {
  return value === undefined ? 1 : Number(value);
}

function parseUnifiedDiff(patch: string): readonly Hunk[] {
  if (patch.includes('\0')) invalid('Patch contains a NUL byte.');
  const rawLines = patch
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (rawLines.at(-1) === '') rawLines.pop();
  if (rawLines.length === 0) invalid('Patch is empty.');

  let index = 0;
  let fileHeaders = 0;
  while (index < rawLines.length && !rawLines[index]?.startsWith('@@ ')) {
    const line = rawLines[index] ?? '';
    if (line.startsWith('--- ')) {
      fileHeaders += 1;
      if (fileHeaders > 1) {
        throw new StrictPatchError('MULTIPLE_FILES', 'Patch must describe exactly one file.');
      }
      const next = rawLines[index + 1];
      if (!next?.startsWith('+++ ')) {
        invalid('A --- file header must be followed by a +++ file header.');
      }
      index += 2;
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ')) {
      index += 1;
      continue;
    }
    invalid(`Unexpected patch header line: ${line}`);
  }

  const hunks: Hunk[] = [];
  while (index < rawLines.length) {
    const header = rawLines[index] ?? '';
    if (header.startsWith('--- ') || header.startsWith('+++ ') || header.startsWith('diff ')) {
      throw new StrictPatchError('MULTIPLE_FILES', 'Patch must describe exactly one file.');
    }
    const match = HUNK_HEADER.exec(header);
    if (match === null) invalid(`Invalid hunk header: ${header}`, hunks.length + 1);
    const oldStart = Number(match[1]);
    const oldCount = parseCount(match[2]);
    const newStart = Number(match[3]);
    const newCount = parseCount(match[4]);
    if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) {
      invalid('Hunk line number is outside the safe integer range.', hunks.length + 1);
    }
    index += 1;

    const lines: (PatchLine & { noNewline: boolean })[] = [];
    while (index < rawLines.length && !rawLines[index]?.startsWith('@@ ')) {
      const line = rawLines[index] ?? '';
      if (line.startsWith('--- ') || line.startsWith('diff ')) break;
      if (line === '\\ No newline at end of file') {
        const previous = lines.at(-1);
        if (previous === undefined || previous.noNewline) {
          invalid('Misplaced no-newline marker.', hunks.length + 1);
        }
        previous.noNewline = true;
        index += 1;
        continue;
      }
      const prefix = line[0];
      if (prefix !== ' ' && prefix !== '-' && prefix !== '+') {
        invalid(`Invalid hunk line: ${line}`, hunks.length + 1);
      }
      lines.push({
        operation: prefix === ' ' ? 'context' : prefix === '-' ? 'remove' : 'add',
        content: line.slice(1),
        noNewline: false,
      });
      index += 1;
    }
    const actualOldCount = lines.filter((line) => line.operation !== 'add').length;
    const actualNewCount = lines.filter((line) => line.operation !== 'remove').length;
    if (actualOldCount !== oldCount || actualNewCount !== newCount) {
      invalid(
        `Hunk counts do not match its header (expected ${String(oldCount)}/${String(newCount)}, received ${String(actualOldCount)}/${String(actualNewCount)}).`,
        hunks.length + 1,
      );
    }
    hunks.push(Object.freeze({ oldStart, oldCount, newStart, newCount, lines }));
  }
  if (hunks.length === 0) invalid('Patch contains no hunks.');
  return Object.freeze(hunks);
}

function splitContent(content: string): {
  readonly lines: string[];
  readonly finalNewline: boolean;
} {
  const finalNewline = content.endsWith('\n');
  const body = finalNewline ? content.slice(0, -1) : content;
  const lines =
    body.length === 0
      ? []
      : body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { lines, finalNewline };
}

export function applyStrictUnifiedPatch(original: string, patch: string): StrictPatchResult {
  const hunks = parseUnifiedDiff(patch);
  const source = splitContent(original);
  const result: string[] = [];
  let sourceIndex = 0;
  let outputFinalNewline = source.finalNewline;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    if (hunk === undefined) continue;
    const targetIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (targetIndex < sourceIndex) {
      throw new StrictPatchError(
        'OVERLAPPING_HUNKS',
        `Hunk ${String(hunkIndex + 1)} overlaps an earlier hunk.`,
        hunkIndex + 1,
      );
    }
    if (targetIndex > source.lines.length) {
      throw new StrictPatchError(
        'CONTEXT_MISMATCH',
        `Hunk ${String(hunkIndex + 1)} starts beyond the end of the file.`,
        hunkIndex + 1,
      );
    }
    result.push(...source.lines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;

    let hunkTouchesEnd = false;
    let explicitNewNoNewline = false;
    for (const line of hunk.lines) {
      if (line.operation !== 'add') {
        const actual = source.lines[sourceIndex];
        if (actual !== line.content) {
          throw new StrictPatchError(
            'CONTEXT_MISMATCH',
            `Hunk ${String(hunkIndex + 1)} expected line ${String(sourceIndex + 1)} to be ${JSON.stringify(line.content)}.`,
            hunkIndex + 1,
          );
        }
        sourceIndex += 1;
        hunkTouchesEnd = sourceIndex === source.lines.length;
      }
      if (line.operation !== 'remove') result.push(line.content);
      if (line.noNewline) {
        if (line.operation !== 'add' && sourceIndex !== source.lines.length) {
          invalid('Old no-newline marker does not refer to the final source line.', hunkIndex + 1);
        }
        if (line.operation !== 'remove') explicitNewNoNewline = true;
      }
    }
    if (hunkTouchesEnd) outputFinalNewline = !explicitNewNoNewline;
  }

  result.push(...source.lines.slice(sourceIndex));
  return Object.freeze({
    content: `${result.join('\n')}${outputFinalNewline && result.length > 0 ? '\n' : ''}`,
    hunksApplied: hunks.length,
  });
}

function validateInput(input: unknown): Readonly<ApplyPatchInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('apply_patch input must be an object.');
  }
  const record = input as unknown as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (key !== 'path' && key !== 'patch') {
      throw new TypeError(`apply_patch input contains unknown property "${key}".`);
    }
  }
  if (typeof record.path !== 'string' || typeof record.patch !== 'string') {
    throw new TypeError('apply_patch requires string path and patch values.');
  }
  return Object.freeze({ path: workspacePath(record.path), patch: record.patch });
}

export function createStrictApplyPatchTool(workspace: TextWorkspace): ApplyPatchTool {
  return Object.freeze({
    name: 'apply_patch',
    description: 'Apply an exact-context, single-file unified diff atomically.',
    operation: WORKSPACE_OPERATIONS.applyPatch,
    async execute(input: ApplyPatchInput, context?: OperationContext): Promise<ApplyPatchOutput> {
      const validated = validateInput(input);
      context?.signal?.throwIfCancelled();
      const original = await workspace.readFile(validated.path, context);
      context?.signal?.throwIfCancelled();
      const result = applyStrictUnifiedPatch(original, validated.patch);
      context?.signal?.throwIfCancelled();
      const created = await workspace.writeFile(validated.path, result.content, context);
      context?.signal?.throwIfCancelled();
      return Object.freeze({ path: validated.path, created, hunksApplied: result.hunksApplied });
    },
  });
}
