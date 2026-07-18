import type { OperationContext } from '@loom/plugin-api';

import type { ProjectWorkspace, WorkspaceEntryKind } from './contracts.js';
import { workspacePath, type WorkspacePath } from './path.js';

export type WorkspaceImportEntry =
  | Readonly<{ path: string; kind: 'directory' }>
  | Readonly<{ path: string; kind: 'file'; content: Uint8Array }>;

export type ValidatedWorkspaceImportEntry =
  | Readonly<{ path: WorkspacePath; kind: 'directory' }>
  | Readonly<{ path: WorkspacePath; kind: 'file'; content: Uint8Array }>;

export interface WorkspaceImportLimits {
  readonly maxEntries?: number;
  readonly maxPathLength?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxCompressionRatio?: number;
}

export interface WorkspaceImportOptions extends WorkspaceImportLimits {
  readonly overwrite?: boolean;
}

export interface BrowserFolderFile {
  readonly name: string;
  readonly webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BrowserFolderImportOptions extends WorkspaceImportOptions {
  /** Remove the common top-level folder emitted by directory upload controls. Defaults to true. */
  readonly stripCommonRoot?: boolean;
}

export type WorkspaceArchiveErrorCode =
  'INVALID_ENTRY' | 'ENTRY_CONFLICT' | 'LIMIT_EXCEEDED' | 'INVALID_ZIP' | 'UNSUPPORTED_ZIP';

export class WorkspaceArchiveError extends Error {
  readonly code: WorkspaceArchiveErrorCode;
  readonly path?: string;

  constructor(
    code: WorkspaceArchiveErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceArchiveError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxPathLength: 1_024,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface NormalizedWorkspaceImportLimits {
  readonly maxEntries: number;
  readonly maxPathLength: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxCompressionRatio: number;
}

function limits(options: WorkspaceImportLimits): NormalizedWorkspaceImportLimits {
  const result = {
    maxEntries: options.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    maxPathLength: options.maxPathLength ?? DEFAULT_LIMITS.maxPathLength,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    maxCompressionRatio: options.maxCompressionRatio ?? DEFAULT_LIMITS.maxCompressionRatio,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(result);
}

function cloneBytes(content: Uint8Array): Uint8Array {
  return Uint8Array.from(content);
}

function parentPaths(path: WorkspacePath): WorkspacePath[] {
  const values: WorkspacePath[] = [];
  let separator = path.lastIndexOf('/');
  while (separator >= 0) {
    values.push(workspacePath(path.slice(0, separator)));
    separator = path.lastIndexOf('/', separator - 1);
  }
  return values.reverse();
}

function safePath(value: string, directory: boolean, maximumLength: number): WorkspacePath {
  const candidate = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (candidate.length > maximumLength) {
    throw new WorkspaceArchiveError(
      'LIMIT_EXCEEDED',
      `Workspace path exceeds ${String(maximumLength)} characters.`,
      candidate,
    );
  }
  try {
    return workspacePath(candidate);
  } catch (cause) {
    throw new WorkspaceArchiveError(
      'INVALID_ENTRY',
      `Unsafe workspace path '${candidate}'.`,
      candidate,
      { cause },
    );
  }
}

export function validateWorkspaceImportEntries(
  entries: readonly WorkspaceImportEntry[],
  options: WorkspaceImportLimits = {},
): readonly ValidatedWorkspaceImportEntry[] {
  const configured = limits(options);
  if (entries.length > configured.maxEntries) {
    throw new WorkspaceArchiveError(
      'LIMIT_EXCEEDED',
      `Workspace import contains more than ${String(configured.maxEntries)} entries.`,
    );
  }
  let totalBytes = 0;
  const byPath = new Map<WorkspacePath, WorkspaceEntryKind>();
  const validated: ValidatedWorkspaceImportEntry[] = [];
  for (const entry of entries) {
    const path = safePath(entry.path, entry.kind === 'directory', configured.maxPathLength);
    if (byPath.has(path)) {
      throw new WorkspaceArchiveError(
        'ENTRY_CONFLICT',
        `Workspace import contains duplicate entry '${path}'.`,
        path,
      );
    }
    for (const parent of parentPaths(path)) {
      if (byPath.get(parent) === 'file') {
        throw new WorkspaceArchiveError(
          'ENTRY_CONFLICT',
          `File '${parent}' cannot contain '${path}'.`,
          path,
        );
      }
    }
    if (entry.kind === 'file') {
      if (!(entry.content instanceof Uint8Array)) {
        throw new WorkspaceArchiveError(
          'INVALID_ENTRY',
          `Workspace file '${path}' has invalid content.`,
          path,
        );
      }
      if (entry.content.byteLength > configured.maxFileBytes) {
        throw new WorkspaceArchiveError(
          'LIMIT_EXCEEDED',
          `Workspace file '${path}' exceeds the per-file size limit.`,
          path,
        );
      }
      totalBytes += entry.content.byteLength;
      if (totalBytes > configured.maxTotalBytes) {
        throw new WorkspaceArchiveError(
          'LIMIT_EXCEEDED',
          'Workspace import exceeds the total uncompressed size limit.',
        );
      }
      byPath.set(path, 'file');
      validated.push(Object.freeze({ path, kind: 'file', content: cloneBytes(entry.content) }));
    } else {
      byPath.set(path, 'directory');
      validated.push(Object.freeze({ path, kind: 'directory' }));
    }
  }

  for (const [path, kind] of byPath) {
    if (kind !== 'file') continue;
    const prefix = `${path}/`;
    if ([...byPath.keys()].some((candidate) => candidate.startsWith(prefix))) {
      throw new WorkspaceArchiveError(
        'ENTRY_CONFLICT',
        `File '${path}' conflicts with a nested import entry.`,
        path,
      );
    }
  }
  validated.sort((left, right) => {
    const depth = left.path.split('/').length - right.path.split('/').length;
    if (depth !== 0) return depth;
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  return Object.freeze(validated);
}

export async function importWorkspaceEntries(
  workspace: ProjectWorkspace,
  entries: readonly WorkspaceImportEntry[],
  options: WorkspaceImportOptions = {},
  context?: OperationContext,
): Promise<readonly ValidatedWorkspaceImportEntry[]> {
  const validated = validateWorkspaceImportEntries(entries, options);
  context?.signal?.throwIfCancelled();

  const desiredKinds = new Map<WorkspacePath, WorkspaceEntryKind>();
  for (const entry of validated) {
    for (const parent of parentPaths(entry.path)) desiredKinds.set(parent, 'directory');
    desiredKinds.set(entry.path, entry.kind);
  }
  const existingKinds = new Map<WorkspacePath, WorkspaceEntryKind>();
  await collectWorkspaceKinds(workspace, undefined, existingKinds, context);
  for (const [path, desiredKind] of desiredKinds) {
    const existingKind = existingKinds.get(path);
    if (existingKind === undefined) continue;
    if (existingKind === desiredKind) {
      if (desiredKind === 'file' && options.overwrite !== true) {
        throw new WorkspaceArchiveError(
          'ENTRY_CONFLICT',
          `Workspace entry '${path}' already exists.`,
          path,
        );
      }
      continue;
    }
    if (options.overwrite !== true) {
      throw new WorkspaceArchiveError(
        'ENTRY_CONFLICT',
        `Workspace entry '${path}' already exists.`,
        path,
      );
    }
    context?.signal?.throwIfCancelled();
    await workspace.remove(path, { recursive: true }, context);
  }

  const directories = new Set<WorkspacePath>();
  for (const entry of validated) {
    for (const parent of parentPaths(entry.path)) directories.add(parent);
    if (entry.kind === 'directory') directories.add(entry.path);
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    context?.signal?.throwIfCancelled();
    await workspace.createDirectory(directory, { recursive: true }, context);
  }
  for (const entry of validated) {
    if (entry.kind !== 'file') continue;
    context?.signal?.throwIfCancelled();
    await workspace.writeBytes(entry.path, entry.content, context);
  }
  context?.signal?.throwIfCancelled();
  return validated;
}

async function collectWorkspaceKinds(
  workspace: ProjectWorkspace,
  directory: WorkspacePath | undefined,
  output: Map<WorkspacePath, WorkspaceEntryKind>,
  context?: OperationContext,
): Promise<void> {
  for (const entry of await workspace.listFiles(directory, context)) {
    context?.signal?.throwIfCancelled();
    output.set(entry.path, entry.kind);
    if (entry.kind === 'directory') {
      await collectWorkspaceKinds(workspace, entry.path, output, context);
    }
  }
}

async function snapshotDirectory(
  workspace: ProjectWorkspace,
  directory: WorkspacePath | undefined,
  output: ValidatedWorkspaceImportEntry[],
  context?: OperationContext,
): Promise<void> {
  const entries = await workspace.listFiles(directory, context);
  for (const entry of entries) {
    context?.signal?.throwIfCancelled();
    if (entry.kind === 'directory') {
      output.push(Object.freeze({ path: entry.path, kind: 'directory' }));
      await snapshotDirectory(workspace, entry.path, output, context);
    } else {
      output.push(
        Object.freeze({
          path: entry.path,
          kind: 'file',
          content: cloneBytes(await workspace.readBytes(entry.path, context)),
        }),
      );
    }
  }
}

export async function snapshotWorkspace(
  workspace: ProjectWorkspace,
  context?: OperationContext,
): Promise<readonly ValidatedWorkspaceImportEntry[]> {
  const output: ValidatedWorkspaceImportEntry[] = [];
  await snapshotDirectory(workspace, undefined, output, context);
  return Object.freeze(output);
}

function commonFolderRoot(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const first = paths[0]?.split('/')[0];
  if (first === undefined || first.length === 0) return undefined;
  return paths.every((path) => path.startsWith(`${first}/`)) ? first : undefined;
}

export async function importBrowserFolderFiles(
  workspace: ProjectWorkspace,
  files: Iterable<BrowserFolderFile>,
  options: BrowserFolderImportOptions = {},
  context?: OperationContext,
): Promise<readonly ValidatedWorkspaceImportEntry[]> {
  const collected = [...files];
  const rawPaths = collected.map((file) =>
    file.webkitRelativePath !== undefined && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name,
  );
  const root = options.stripCommonRoot === false ? undefined : commonFolderRoot(rawPaths);
  const entries: WorkspaceImportEntry[] = [];
  for (let index = 0; index < collected.length; index += 1) {
    context?.signal?.throwIfCancelled();
    const file = collected[index];
    const rawPath = rawPaths[index];
    if (file === undefined || rawPath === undefined) continue;
    const path = root === undefined ? rawPath : rawPath.slice(root.length + 1);
    entries.push({ path, kind: 'file', content: new Uint8Array(await file.arrayBuffer()) });
  }
  return importWorkspaceEntries(workspace, entries, options, context);
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

let crcTable: Uint32Array | undefined;

function crc32(content: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of content) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

interface MinimalStreamWriter {
  write(value: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface MinimalStreamReader {
  read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
}

interface MinimalDecompressionStream {
  readonly writable: { getWriter(): MinimalStreamWriter };
  readonly readable: { getReader(): MinimalStreamReader };
}

async function inflateRaw(content: Uint8Array): Promise<Uint8Array> {
  const constructor = (
    globalThis as unknown as {
      readonly DecompressionStream?: new (format: string) => MinimalDecompressionStream;
    }
  ).DecompressionStream;
  if (constructor === undefined) {
    throw new WorkspaceArchiveError(
      'UNSUPPORTED_ZIP',
      'This environment cannot decompress deflated ZIP entries.',
    );
  }
  let stream: MinimalDecompressionStream;
  try {
    stream = new constructor('deflate-raw');
  } catch (cause) {
    throw new WorkspaceArchiveError(
      'UNSUPPORTED_ZIP',
      'This environment does not support raw DEFLATE streams.',
      undefined,
      { cause },
    );
  }
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value !== undefined) chunks.push(result.value);
    }
    return concatBytes(chunks);
  })();
  await writer.write(content);
  await writer.close();
  return reading;
}

interface CentralZipEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly compression: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function endOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      u32(view, offset) === 0x06054b50 &&
      offset + 22 + u16(view, offset + 20) === view.byteLength
    ) {
      return offset;
    }
  }
  throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP end-of-directory record is missing.');
}

function centralEntries(
  bytes: Uint8Array,
  configured: NormalizedWorkspaceImportLimits,
): CentralZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfCentralDirectory(view);
  const disk = u16(view, end + 4);
  const centralDisk = u16(view, end + 6);
  const count = u16(view, end + 10);
  const centralSize = u32(view, end + 12);
  const centralOffset = u32(view, end + 16);
  if (disk !== 0 || centralDisk !== 0) {
    throw new WorkspaceArchiveError('UNSUPPORTED_ZIP', 'Multi-disk ZIP archives are unsupported.');
  }
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new WorkspaceArchiveError('UNSUPPORTED_ZIP', 'ZIP64 archives are unsupported.');
  }
  if (count > configured.maxEntries) {
    throw new WorkspaceArchiveError('LIMIT_EXCEEDED', 'ZIP contains too many entries.');
  }
  if (centralOffset + centralSize > end) {
    throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP central directory is out of bounds.');
  }

  const entries: CentralZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || u32(view, offset) !== 0x02014b50) {
      throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP central entry is malformed.');
    }
    const flags = u16(view, offset + 8);
    const compression = u16(view, offset + 10);
    const crc = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const externalAttributes = u32(view, offset + 38);
    const localOffset = u32(view, offset + 42);
    const endOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (endOffset > bytes.byteLength) {
      throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP entry metadata is out of bounds.');
    }
    if ((flags & 1) !== 0) {
      throw new WorkspaceArchiveError('UNSUPPORTED_ZIP', 'Encrypted ZIP entries are unsupported.');
    }
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) {
      throw new WorkspaceArchiveError('UNSUPPORTED_ZIP', 'ZIP symbolic links are unsupported.');
    }
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch (cause) {
      throw new WorkspaceArchiveError(
        'INVALID_ZIP',
        'ZIP entry name is not valid UTF-8.',
        undefined,
        { cause },
      );
    }
    entries.push({
      path,
      directory: path.endsWith('/') || unixType === 0x4000,
      compression,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = endOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP central directory size is inconsistent.');
  }
  return entries;
}

async function extractZipEntry(bytes: Uint8Array, entry: CentralZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (offset + 30 > bytes.byteLength || u32(view, offset) !== 0x04034b50) {
    throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP local entry is malformed.', entry.path);
  }
  const nameLength = u16(view, offset + 26);
  const extraLength = u16(view, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP entry data is out of bounds.', entry.path);
  }
  const compressed = bytes.subarray(dataOffset, dataEnd);
  const content =
    entry.compression === 0
      ? cloneBytes(compressed)
      : entry.compression === 8
        ? await inflateRaw(compressed)
        : (() => {
            throw new WorkspaceArchiveError(
              'UNSUPPORTED_ZIP',
              `ZIP compression method ${String(entry.compression)} is unsupported.`,
              entry.path,
            );
          })();
  if (content.byteLength !== entry.uncompressedSize || crc32(content) !== entry.crc) {
    throw new WorkspaceArchiveError('INVALID_ZIP', 'ZIP entry checksum is invalid.', entry.path);
  }
  return content;
}

export async function decodeWorkspaceZip(
  bytes: Uint8Array,
  options: WorkspaceImportLimits = {},
): Promise<readonly ValidatedWorkspaceImportEntry[]> {
  const configured = limits(options);
  const central = centralEntries(bytes, configured);
  let total = 0;
  const entries: WorkspaceImportEntry[] = [];
  for (const entry of central) {
    safePath(entry.path, entry.directory, configured.maxPathLength);
    if (entry.uncompressedSize > configured.maxFileBytes) {
      throw new WorkspaceArchiveError('LIMIT_EXCEEDED', 'ZIP entry is too large.', entry.path);
    }
    total += entry.uncompressedSize;
    if (total > configured.maxTotalBytes) {
      throw new WorkspaceArchiveError('LIMIT_EXCEEDED', 'ZIP expands beyond the total size limit.');
    }
    if (
      (entry.uncompressedSize > 0 && entry.compressedSize === 0) ||
      (entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > configured.maxCompressionRatio)
    ) {
      throw new WorkspaceArchiveError(
        'LIMIT_EXCEEDED',
        'ZIP entry exceeds the compression-ratio limit.',
        entry.path,
      );
    }
    entries.push(
      entry.directory
        ? { path: entry.path, kind: 'directory' }
        : { path: entry.path, kind: 'file', content: await extractZipEntry(bytes, entry) },
    );
  }
  return validateWorkspaceImportEntries(entries, configured);
}

export async function importWorkspaceZip(
  workspace: ProjectWorkspace,
  bytes: Uint8Array,
  options: WorkspaceImportOptions = {},
  context?: OperationContext,
): Promise<readonly ValidatedWorkspaceImportEntry[]> {
  const entries = await decodeWorkspaceZip(bytes, options);
  return importWorkspaceEntries(workspace, entries, options, context);
}

interface EncodedZipEntry {
  readonly name: Uint8Array;
  readonly content: Uint8Array;
  readonly crc: number;
  readonly directory: boolean;
  readonly offset: number;
}

export function encodeWorkspaceZip(entries: readonly WorkspaceImportEntry[]): Uint8Array {
  const validated = validateWorkspaceImportEntries(entries);
  const localParts: Uint8Array[] = [];
  const encoded: EncodedZipEntry[] = [];
  let offset = 0;
  for (const entry of validated) {
    const content = entry.kind === 'file' ? entry.content : new Uint8Array();
    const name = encoder.encode(entry.kind === 'directory' ? `${entry.path}/` : entry.path);
    const local = new Uint8Array(30 + name.byteLength);
    const view = new DataView(local.buffer);
    writeU32(view, 0, 0x04034b50);
    writeU16(view, 4, 20);
    writeU16(view, 6, 0x0800);
    writeU16(view, 8, 0);
    writeU32(view, 14, crc32(content));
    writeU32(view, 18, content.byteLength);
    writeU32(view, 22, content.byteLength);
    writeU16(view, 26, name.byteLength);
    local.set(name, 30);
    localParts.push(local, content);
    encoded.push({
      name,
      content,
      crc: crc32(content),
      directory: entry.kind === 'directory',
      offset,
    });
    offset += local.byteLength + content.byteLength;
  }

  const centralParts: Uint8Array[] = [];
  for (const entry of encoded) {
    const central = new Uint8Array(46 + entry.name.byteLength);
    const view = new DataView(central.buffer);
    writeU32(view, 0, 0x02014b50);
    writeU16(view, 4, 0x0314);
    writeU16(view, 6, 20);
    writeU16(view, 8, 0x0800);
    writeU16(view, 10, 0);
    writeU32(view, 16, entry.crc);
    writeU32(view, 20, entry.content.byteLength);
    writeU32(view, 24, entry.content.byteLength);
    writeU16(view, 28, entry.name.byteLength);
    writeU32(view, 38, entry.directory ? 0x41ed0010 : 0x81a40000);
    writeU32(view, 42, entry.offset);
    central.set(entry.name, 46);
    centralParts.push(central);
  }
  const central = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 8, encoded.length);
  writeU16(endView, 10, encoded.length);
  writeU32(endView, 12, central.byteLength);
  writeU32(endView, 16, offset);
  return concatBytes([...localParts, central, end]);
}

export async function exportWorkspaceZip(
  workspace: ProjectWorkspace,
  context?: OperationContext,
): Promise<Uint8Array> {
  return encodeWorkspaceZip(await snapshotWorkspace(workspace, context));
}
