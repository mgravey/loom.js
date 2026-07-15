import { type CodexModel, type CodexModelEvent, type CodexModelRequest } from '@loom/agent-codex';
import {
  PLUGIN_API_VERSION,
  definePlugin,
  modelKey,
  registerModel,
  type LoomPlugin,
  type OperationContext,
} from '@loom/plugin-api';
import {
  WORKSPACE_OPERATIONS,
  workspacePath,
  type TextWorkspace,
  type WorkspaceEntry,
  type WorkspacePath,
} from '@loom/tool-workspace';
import {
  capabilityId,
  pluginId,
  semanticVersion,
  type JsonObject,
  type JsonValue,
  type SessionId,
} from '@loom/types';

export const EXAMPLE_CODEX_MODEL_PLUGIN_ID = pluginId('loom-example/codex-model');
export const EXAMPLE_CODEX_MODEL_CAPABILITY_ID = capabilityId('loom-example/codex-model');
export const EXAMPLE_CODEX_MODEL_KEY = modelKey<CodexModelRequest, CodexModelEvent>(
  EXAMPLE_CODEX_MODEL_CAPABILITY_ID,
);

const SOURCE_PATH = workspacePath('source.txt');
const RESULT_PATH = workspacePath('result.txt');

function toolResults(request: CodexModelRequest) {
  return request.messages.filter((message) => message.role === 'tool');
}

function readContent(value: JsonValue): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('The scripted model expected a read_file result with string content.');
  }
  const record = value as JsonObject;
  if (typeof record.content !== 'string') {
    throw new TypeError('The scripted model expected a read_file result with string content.');
  }
  return record.content;
}

/** A stateless transcript-driven model fixture for the Phase 2 agent loop. */
export const SCRIPTED_CODEX_AGENT_MODEL: CodexModel = Object.freeze({
  async *generate(
    request: CodexModelRequest,
    context?: OperationContext,
  ): AsyncIterable<CodexModelEvent> {
    context?.signal?.throwIfCancelled();
    await Promise.resolve();
    const results = toolResults(request);

    if (results.length === 0) {
      yield Object.freeze({
        type: 'tool-call',
        call: Object.freeze({
          id: 'call-list',
          operation: WORKSPACE_OPERATIONS.listFiles,
          input: Object.freeze({}),
        }),
      });
    } else if (results.length === 1) {
      yield Object.freeze({
        type: 'tool-call',
        call: Object.freeze({
          id: 'call-read',
          operation: WORKSPACE_OPERATIONS.readFile,
          input: Object.freeze({ path: SOURCE_PATH }),
        }),
      });
    } else if (results.length === 2) {
      yield Object.freeze({
        type: 'tool-call',
        call: Object.freeze({
          id: 'call-write',
          operation: WORKSPACE_OPERATIONS.writeFile,
          input: Object.freeze({
            path: RESULT_PATH,
            content: `Processed: ${readContent(results[1]?.result ?? null)}`,
          }),
        }),
      });
    } else {
      yield Object.freeze({ type: 'text', text: 'Workspace updated.' });
    }
    yield Object.freeze({ type: 'completed' });
  },
});

export function createScriptedCodexModelPlugin(): LoomPlugin {
  return definePlugin({
    manifest: {
      id: EXAMPLE_CODEX_MODEL_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerModel<CodexModelRequest, CodexModelEvent>(
        context.capabilities,
        EXAMPLE_CODEX_MODEL_CAPABILITY_ID,
        SCRIPTED_CODEX_AGENT_MODEL,
      );
    },
  });
}

export interface WorkspaceInvocation {
  readonly operation: 'listFiles' | 'readFile' | 'writeFile';
  readonly path?: WorkspacePath;
  readonly sessionId?: SessionId;
}

export interface InMemoryTextWorkspace extends TextWorkspace {
  snapshot(): Readonly<Record<string, string>>;
  invocations(): readonly WorkspaceInvocation[];
}

function invocation(
  operation: WorkspaceInvocation['operation'],
  path: WorkspacePath | undefined,
  context: OperationContext | undefined,
): WorkspaceInvocation {
  return Object.freeze({
    operation,
    ...(path === undefined ? {} : { path }),
    ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  });
}

function immediateEntries(
  files: ReadonlyMap<WorkspacePath, string>,
  parent: WorkspacePath | undefined,
): readonly WorkspaceEntry[] {
  const prefix = parent === undefined ? '' : `${parent}/`;
  const entries = new Map<WorkspacePath, WorkspaceEntry['kind']>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (remainder.length === 0) continue;
    const separator = remainder.indexOf('/');
    const child = separator < 0 ? remainder : remainder.slice(0, separator);
    const childPath = workspacePath(`${prefix}${child}`);
    entries.set(childPath, separator < 0 ? 'file' : 'directory');
  }
  return Object.freeze(
    [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, kind]) => Object.freeze({ path, kind })),
  );
}

export function createInMemoryTextWorkspace(
  initialFiles: Readonly<Record<string, string>> = Object.freeze({
    [SOURCE_PATH]: 'hello Loom',
  }),
): InMemoryTextWorkspace {
  const files = new Map<WorkspacePath, string>();
  const calls: WorkspaceInvocation[] = [];
  for (const [path, content] of Object.entries(initialFiles)) {
    if (typeof content !== 'string') throw new TypeError('Workspace content must be a string.');
    files.set(workspacePath(path), content);
  }

  return Object.freeze({
    listFiles: (
      path: WorkspacePath | undefined,
      context?: OperationContext,
    ): Promise<readonly WorkspaceEntry[]> => {
      context?.signal?.throwIfCancelled();
      calls.push(invocation('listFiles', path, context));
      return Promise.resolve(immediateEntries(files, path));
    },
    readFile: (path: WorkspacePath, context?: OperationContext): Promise<string> => {
      context?.signal?.throwIfCancelled();
      calls.push(invocation('readFile', path, context));
      const content = files.get(path);
      if (content === undefined) throw new Error(`Workspace file '${path}' does not exist.`);
      return Promise.resolve(content);
    },
    writeFile: (
      path: WorkspacePath,
      content: string,
      context?: OperationContext,
    ): Promise<boolean> => {
      context?.signal?.throwIfCancelled();
      calls.push(invocation('writeFile', path, context));
      const created = !files.has(path);
      files.set(path, content);
      return Promise.resolve(created);
    },
    snapshot: () =>
      Object.freeze(
        Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right))),
      ),
    invocations: () => Object.freeze([...calls]),
  });
}

/** Configuration used to prove that session overlays replace runtime agent configuration. */
export const EXAMPLE_CODEX_SESSION_CONFIGURATION: JsonObject = Object.freeze({ maxTurns: 4 });
