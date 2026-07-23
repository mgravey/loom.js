import type { OperationContext } from '@mgravey/loom-plugin-api';
import {
  WORKSPACE_OPERATIONS,
  workspacePath,
  type ListFilesTool,
  type ReadFileTool,
  type WorkspaceTool,
  type WriteFileTool,
} from '@mgravey/loom-tool-workspace';
import { createCancellationSource, type JsonObject } from '@mgravey/loom-types';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_AGENT_CAPABILITY_ID,
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  DEFAULT_CODEX_INSTRUCTIONS,
  createCodexAgentFactory,
  createCodexAgentPlugin,
  type CodexAgent,
  type CodexAgentDependencies,
  type CodexAgentEvent,
  type CodexAgentTool,
  type CodexContextCompactableModel,
  type CodexModel,
  type CodexModelEvent,
  type CodexModelRequest,
  type CodexTool,
} from '../src/index.js';

interface ToolsFixture {
  readonly tools: readonly WorkspaceTool[];
  readonly listFiles: ListFilesTool;
  readonly readFile: ReadFileTool;
  readonly writeFile: WriteFileTool;
}

function createTools(): ToolsFixture {
  const listFiles: ListFilesTool = {
    name: 'list_files',
    operation: WORKSPACE_OPERATIONS.listFiles,
    execute: vi.fn(async () => ({
      entries: [{ path: workspacePath('src'), kind: 'directory' as const }],
    })),
  };
  const readFile: ReadFileTool = {
    name: 'read_file',
    operation: WORKSPACE_OPERATIONS.readFile,
    execute: vi.fn(async (input) => ({ path: input.path, content: 'old' })),
  };
  const writeFile: WriteFileTool = {
    name: 'write_file',
    operation: WORKSPACE_OPERATIONS.writeFile,
    execute: vi.fn(async (input) => ({ path: input.path, created: true })),
  };
  return { tools: [listFiles, readFile, writeFile], listFiles, readFile, writeFile };
}

function scriptedModel(
  turns: readonly (readonly unknown[])[],
  requests: CodexModelRequest[] = [],
  contexts: (OperationContext | undefined)[] = [],
): CodexModel {
  let index = 0;
  return {
    async *generate(request, context) {
      requests.push(request);
      contexts.push(context);
      const events = turns[index] ?? [];
      index += 1;
      for (const event of events) yield event as CodexModelEvent;
    },
  };
}

function dependencies(
  model: CodexModel,
  tools: readonly CodexAgentTool[] = createTools().tools,
  configuration: JsonObject = {},
): CodexAgentDependencies {
  return { model, tools, configuration };
}

async function collect(agent: CodexAgent, prompt = 'Please update the workspace') {
  const events: CodexAgentEvent[] = [];
  for await (const event of agent.run({ prompt })) events.push(event);
  return events;
}

describe('Codex agent orchestration', () => {
  it('loops through all workspace operations, preserves context, and streams immutable history', async () => {
    const fixture = createTools();
    const requests: CodexModelRequest[] = [];
    const contexts: (OperationContext | undefined)[] = [];
    const model = scriptedModel(
      [
        [
          { type: 'text', text: 'Working. ' },
          {
            type: 'tool-call',
            call: { id: 'list', operation: WORKSPACE_OPERATIONS.listFiles, input: {} },
          },
          {
            type: 'tool-call',
            call: {
              id: 'read',
              operation: WORKSPACE_OPERATIONS.readFile,
              input: { path: 'src/index.ts' },
            },
          },
          {
            type: 'tool-call',
            call: {
              id: 'write',
              operation: WORKSPACE_OPERATIONS.writeFile,
              input: { path: 'src/index.ts', content: 'new' },
            },
          },
          { type: 'completed' },
        ],
        [{ type: 'text', text: 'Done.' }, { type: 'completed' }],
      ],
      requests,
      contexts,
    );
    const agent = createCodexAgentFactory().create(
      dependencies(model, fixture.tools, {
        maxTurns: 4,
        instructions: 'Work only inside the supplied workspace.',
      }),
    ) as CodexAgent;
    const cancellation = createCancellationSource();
    const context = { signal: cancellation.signal };
    const events: CodexAgentEvent[] = [];
    for await (const event of agent.run({ prompt: 'Update it' }, context)) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'text',
      'tool-start',
      'tool-finish',
      'tool-start',
      'tool-finish',
      'tool-start',
      'tool-finish',
      'text',
      'completed',
    ]);
    expect(contexts).toEqual([context, context]);
    expect(fixture.listFiles.execute).toHaveBeenCalledWith({}, context);
    expect(fixture.readFile.execute).toHaveBeenCalledWith({ path: 'src/index.ts' }, context);
    expect(fixture.writeFile.execute).toHaveBeenCalledWith(
      { path: 'src/index.ts', content: 'new' },
      context,
    );
    expect(requests[0]?.instructions).toBe('Work only inside the supplied workspace.');
    expect(requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
    ]);
    expect(Object.isFrozen(requests[1]?.messages)).toBe(true);
    const toolResult = requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolResult === undefined ? false : Object.isFrozen(toolResult.result)).toBe(true);
  });

  it('uses concise default instructions', async () => {
    const requests: CodexModelRequest[] = [];
    const model = scriptedModel([[{ type: 'completed' }]], requests);
    await collect(createCodexAgentFactory().create(dependencies(model)) as CodexAgent);
    expect(requests[0]?.instructions).toBe(DEFAULT_CODEX_INSTRUCTIONS);
  });

  it('advertises and executes application-defined schema tools', async () => {
    const requests: CodexModelRequest[] = [];
    const inspectCart = vi.fn(async () => ({ items: 3, total: 42 }));
    const websiteTool: CodexTool = {
      name: 'inspect_cart',
      operation: 'website/cart-summary',
      description: 'Read the current shopping-cart summary shown by the website.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { items: { type: 'number' }, total: { type: 'number' } },
        required: ['items', 'total'],
        additionalProperties: false,
      },
      execute: inspectCart,
    };
    const model = scriptedModel(
      [
        [
          {
            type: 'tool-call',
            call: { id: 'cart', operation: 'website/cart-summary', input: {} },
          },
          { type: 'completed' },
        ],
        [{ type: 'text', text: 'There are three items.' }, { type: 'completed' }],
      ],
      requests,
    );

    const events = await collect(
      createCodexAgentFactory().create(dependencies(model, [websiteTool])) as CodexAgent,
    );

    expect(inspectCart).toHaveBeenCalledWith({}, undefined);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        operation: 'website/cart-summary',
        description: expect.stringContaining('shopping-cart'),
        allowedCallers: ['direct'],
      }),
    ]);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      operation: 'website/cart-summary',
      result: { items: 3, total: 42 },
    });
    expect(events.map((event) => event.type)).toEqual([
      'tool-start',
      'tool-finish',
      'text',
      'completed',
    ]);
  });

  it('preserves continuation items and runs nested read-only calls concurrently', async () => {
    const fixture = createTools();
    const requests: CodexModelRequest[] = [];
    let activeReads = 0;
    let maximumActiveReads = 0;
    fixture.readFile.execute = vi.fn(async (input) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return { path: input.path, content: String(input.path) };
    });
    const caller = { type: 'program', caller_id: 'call-program' } as const;
    const program = {
      type: 'program',
      id: 'program-1',
      call_id: 'call-program',
      code: 'await Promise.all([])',
      fingerprint: 'opaque',
    } as const;
    const model = scriptedModel(
      [
        [
          { type: 'continuation', item: program },
          {
            type: 'tool-call',
            call: {
              id: 'read-a',
              operation: WORKSPACE_OPERATIONS.readFile,
              input: { path: 'a.ts' },
              caller,
            },
          },
          {
            type: 'tool-call',
            call: {
              id: 'read-b',
              operation: WORKSPACE_OPERATIONS.readFile,
              input: { path: 'b.ts' },
              caller,
            },
          },
          { type: 'completed', final: false },
        ],
        [
          { type: 'text', text: 'Inspected.' },
          { type: 'completed', final: true },
        ],
      ],
      requests,
    );
    const events = await collect(
      createCodexAgentFactory().create(dependencies(model, fixture.tools)) as CodexAgent,
    );

    expect(maximumActiveReads).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      'tool-start',
      'tool-start',
      'tool-finish',
      'tool-finish',
      'text',
      'completed',
    ]);
    const assistant = requests[1]?.messages.find((message) => message.role === 'assistant');
    expect(assistant).toMatchObject({ continuationItems: [program] });
    const toolMessages = requests[1]?.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages?.every((message) => message.caller?.caller_id === 'call-program')).toBe(
      true,
    );
  });

  it('continues a completed provider response until a final assistant message exists', async () => {
    const requests: CodexModelRequest[] = [];
    const model = scriptedModel(
      [
        [
          {
            type: 'continuation',
            item: {
              type: 'program_output',
              id: 'output-1',
              call_id: 'program-1',
              result: '{}',
              status: 'completed',
            },
          },
          { type: 'completed', final: false },
        ],
        [{ type: 'text', text: 'Final.' }, { type: 'completed' }],
      ],
      requests,
    );

    await expect(
      collect(createCodexAgentFactory().create(dependencies(model)) as CodexAgent),
    ).resolves.toEqual([
      { type: 'text', text: 'Final.' },
      { type: 'completed', turns: 2 },
    ]);
    expect(requests).toHaveLength(2);
  });

  it('rejects a workspace write attributed to a hosted program', async () => {
    const model = scriptedModel([
      [
        {
          type: 'tool-call',
          call: {
            id: 'write',
            operation: WORKSPACE_OPERATIONS.writeFile,
            input: { path: 'file.ts', content: 'unsafe' },
            caller: { type: 'program', caller_id: 'program-1' },
          },
        },
        { type: 'completed' },
      ],
    ]);

    await expect(
      collect(createCodexAgentFactory().create(dependencies(model)) as CodexAgent),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_TOOL_CALL' });
  });

  it('validates configuration, custom schemas, requests, and unique operations', async () => {
    const factory = createCodexAgentFactory();
    const model = scriptedModel([[{ type: 'completed' }]]);
    const fixture = createTools();

    expect(() =>
      factory.create(dependencies(model, [...fixture.tools, fixture.listFiles])),
    ).toThrow(/Duplicate/);
    const missingSchema = {
      name: 'website_action',
      operation: 'website/action',
      description: 'Perform a website action.',
      execute: async () => null,
    } as unknown as CodexAgentTool;
    expect(() => factory.create(dependencies(model, [...fixture.tools, missingSchema]))).toThrow(
      /input schema/,
    );
    const primitiveSchema = {
      ...missingSchema,
      inputSchema: { type: 'string' },
    } as unknown as CodexAgentTool;
    expect(() => factory.create(dependencies(model, [...fixture.tools, primitiveSchema]))).toThrow(
      /object JSON input schema/,
    );
    const invalidOperation = {
      ...missingSchema,
      operation: 'website action',
      inputSchema: { type: 'object' },
    } as unknown as CodexAgentTool;
    expect(() => factory.create(dependencies(model, [...fixture.tools, invalidOperation]))).toThrow(
      /operation.*invalid/,
    );
    expect(() => factory.create(dependencies(model, fixture.tools, { maxTurns: 0 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() =>
      factory.create(dependencies(model, fixture.tools, { instructions: '   ' })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(() =>
      factory.create(dependencies(model, fixture.tools, { unexpected: true })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));

    const agent = factory.create(dependencies(model, fixture.tools)) as CodexAgent;
    await expect(collect(agent, '')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const invalidRequest = agent.run({ prompt: 'valid', extra: true } as never);
    await expect(async () => {
      for await (const event of invalidRequest) void event;
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each([
    ['malformed event', [null], 'MALFORMED_MODEL_EVENT'],
    ['unknown event', [{ type: 'provider-specific' }], 'UNKNOWN_MODEL_EVENT'],
    ['missing completed', [{ type: 'text', text: 'partial' }], 'MALFORMED_MODEL_EVENT'],
    [
      'malformed call',
      [
        {
          type: 'tool-call',
          call: { id: '', operation: WORKSPACE_OPERATIONS.readFile, input: {} },
        },
      ],
      'MALFORMED_TOOL_CALL',
    ],
    [
      'unknown operation',
      [{ type: 'tool-call', call: { id: 'x', operation: 'workspace/delete', input: {} } }],
      'UNKNOWN_TOOL_OPERATION',
    ],
  ] as const)('rejects %s', async (_label, turn, code) => {
    const agent = createCodexAgentFactory().create(
      dependencies(scriptedModel([turn])),
    ) as CodexAgent;
    await expect(collect(agent)).rejects.toMatchObject({ code });
  });

  it('wraps model failures and returns tool failures to the model for recovery', async () => {
    const modelCause = new Error('model offline');
    const failingModel: CodexModel = {
      async *generate() {
        yield* [] as CodexModelEvent[];
        throw modelCause;
      },
    };
    const modelAgent = createCodexAgentFactory().create(dependencies(failingModel)) as CodexAgent;
    await expect(collect(modelAgent)).rejects.toMatchObject({
      code: 'MODEL_FAILURE',
      cause: modelCause,
    });

    const fixture = createTools();
    const toolCause = new Error('read failed');
    fixture.readFile.execute = vi.fn(async () => {
      throw toolCause;
    });
    const requests: CodexModelRequest[] = [];
    const toolModel = scriptedModel(
      [
        [
          {
            type: 'tool-call',
            call: {
              id: 'read',
              operation: WORKSPACE_OPERATIONS.readFile,
              input: { path: 'file.ts' },
            },
          },
          { type: 'completed' },
        ],
        [{ type: 'text', text: 'Recovered.' }, { type: 'completed' }],
      ],
      requests,
    );
    const toolAgent = createCodexAgentFactory().create(
      dependencies(toolModel, fixture.tools),
    ) as CodexAgent;
    const events = await collect(toolAgent);
    expect(events.map((event) => event.type)).toEqual([
      'tool-start',
      'tool-finish',
      'text',
      'completed',
    ]);
    expect(events[1]).toMatchObject({
      type: 'tool-finish',
      result: {
        ok: false,
        error: { code: 'TOOL_FAILURE', message: 'read failed' },
      },
    });
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      result: {
        ok: false,
        error: { code: 'TOOL_FAILURE', message: 'read failed' },
      },
    });
  });

  it('reactively compacts a context overflow and retries only the failed model turn', async () => {
    const requests: CodexModelRequest[] = [];
    const compactRequests: CodexModelRequest[] = [];
    let generation = 0;
    const model: CodexContextCompactableModel = {
      compact(request) {
        compactRequests.push(request);
        return Promise.resolve({
          items: [{ type: 'compaction', encrypted_content: 'opaque-checkpoint' }],
        });
      },
      async *generate(request) {
        requests.push(request);
        generation += 1;
        if (generation === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'list-before-compact',
              operation: WORKSPACE_OPERATIONS.listFiles,
              input: {},
            },
          };
          yield { type: 'completed' };
          return;
        }
        if (generation === 2) {
          const overflow = Object.assign(new Error('input too large'), {
            code: 'PROVIDER_ERROR',
            providerCode: 'context_length_exceeded',
            contextCompactionRequired: true,
          });
          throw overflow;
        }
        yield { type: 'text', text: 'Resumed after compaction.' };
        yield { type: 'completed' };
      },
    };
    const agent = createCodexAgentFactory().create(dependencies(model)) as CodexAgent;

    const events = await collect(agent);

    expect(events.map((event) => event.type)).toEqual([
      'tool-start',
      'tool-finish',
      'context-compacted',
      'text',
      'completed',
    ]);
    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(requests[2]).toMatchObject({
      contextItems: [{ type: 'compaction', encrypted_content: 'opaque-checkpoint' }],
      messages: [],
    });
  });

  it('propagates the compaction signal when the model has no compactor', async () => {
    const overflow = Object.assign(new Error('input too large'), {
      providerCode: 'context_length_exceeded',
      contextCompactionRequired: true,
    });
    const model: CodexModel = {
      async *generate() {
        yield* [] as CodexModelEvent[];
        throw overflow;
      },
    };
    const agent = createCodexAgentFactory().create(dependencies(model)) as CodexAgent;

    await expect(collect(agent)).rejects.toMatchObject({
      code: 'MODEL_FAILURE',
      contextCompactionRequired: true,
      details: { turn: 1, contextCompactionRequired: true },
      cause: overflow,
    });
  });

  it('preserves cancellation rather than wrapping it', async () => {
    const cancellation = createCancellationSource();
    cancellation.cancel('stop');
    const model = scriptedModel([[{ type: 'completed' }]]);
    const agent = createCodexAgentFactory().create(dependencies(model)) as CodexAgent;
    const operation = agent.run({ prompt: 'work' }, { signal: cancellation.signal });

    await expect(async () => {
      for await (const event of operation) void event;
    }).rejects.toMatchObject({ name: 'CancellationError', reason: 'stop' });
  });

  it('throws when tool calls exhaust maxTurns', async () => {
    const turn = [
      {
        type: 'tool-call',
        call: { id: 'one', operation: WORKSPACE_OPERATIONS.listFiles, input: {} },
      },
      { type: 'completed' },
    ];
    const second = [
      {
        type: 'tool-call',
        call: { id: 'two', operation: WORKSPACE_OPERATIONS.listFiles, input: {} },
      },
      { type: 'completed' },
    ];
    const agent = createCodexAgentFactory().create(
      dependencies(scriptedModel([turn, second]), createTools().tools, { maxTurns: 2 }),
    ) as CodexAgent;
    await expect(collect(agent)).rejects.toMatchObject({ code: 'MAX_TURNS_EXCEEDED' });
  });

  it('keeps concurrent invocation histories and call IDs isolated', async () => {
    const requests: CodexModelRequest[] = [];
    const model: CodexModel = {
      async *generate(request) {
        requests.push(request);
        const prompt = request.messages[0];
        if (request.messages.length === 1) {
          await Promise.resolve();
          yield {
            type: 'tool-call',
            call: { id: 'shared', operation: WORKSPACE_OPERATIONS.listFiles, input: {} },
          };
          yield { type: 'completed' };
        } else {
          yield { type: 'text', text: prompt?.role === 'user' ? prompt.content : 'invalid' };
          yield { type: 'completed' };
        }
      },
    };
    const agent = createCodexAgentFactory().create(dependencies(model)) as CodexAgent;
    const [first, second] = await Promise.all([collect(agent, 'first'), collect(agent, 'second')]);

    expect(first.find((event) => event.type === 'text')).toMatchObject({ text: 'first' });
    expect(second.find((event) => event.type === 'text')).toMatchObject({ text: 'second' });
    expect(requests.filter((request) => request.messages.length === 1)).toHaveLength(2);
  });

  it('registers only the typed agent capability', async () => {
    const register = vi.fn();
    const plugin = createCodexAgentPlugin();
    await plugin.initialize?.({ capabilities: { register } } as never);

    expect(plugin.manifest.id).toBe(CODEX_AGENT_PLUGIN_ID);
    expect(CODEX_AGENT_KEY.id).toBe(CODEX_AGENT_CAPABILITY_ID);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toEqual(CODEX_AGENT_KEY);
  });
});
