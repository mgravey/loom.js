import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 4 * 1024 * 1024;
export class HelperError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function generationArguments(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u.test(model))
    throw new HelperError('INVALID_MODEL', 400);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'tool_calls'],
    properties: {
      text: { type: 'string' },
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'arguments'],
          properties: { name: { type: 'string' }, arguments: { type: 'string' } },
        },
      },
    },
  };
  return [
    '--print',
    '--safe-mode',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--model',
    model,
    '--json-schema',
    JSON.stringify(schema),
  ];
}
export async function runClaude(binary, args, input, signal, timeoutMs = 300000) {
  const cwd = await mkdtemp(join(tmpdir(), 'loom-claude-run-'));
  try {
    return await new Promise((resolveResult, reject) => {
      if (signal.aborted) {
        reject(new HelperError('CANCELLED', 499));
        return;
      }
      let done = false,
        output = [],
        bytes = 0;
      const child = spawn(binary, args, {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let killTimer;
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          /* Already exited. */
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* Already exited. */
          }
        }, 500);
        killTimer.unref();
      };
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) {
          kill();
          reject(error);
        } else resolveResult(result);
      };
      const abort = () => finish(new HelperError('CANCELLED', 499));
      const timer = setTimeout(() => finish(new HelperError('DEADLINE_EXCEEDED', 504)), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new HelperError('CLAUDE_NOT_AVAILABLE', 503)));
      child.stdout.on('data', (data) => {
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024) finish(new HelperError('RESPONSE_TOO_LARGE'));
        else output.push(data);
      });
      child.stderr.resume(); // Never log prompts, login URLs, credentials, or raw CLI errors.
      child.stdin.on('error', () => undefined);
      child.on('close', (code) => {
        clearTimeout(killTimer);
        finish(
          code === 0 ? undefined : new HelperError('CLAUDE_COMMAND_FAILED'),
          Buffer.concat(output).toString('utf8'),
        );
      });
      child.stdin.end(input);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
function json(source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new HelperError('INVALID_CLAUDE_RESPONSE');
  }
}
async function account(run, signal) {
  const status = json(await run(['auth', 'status'], '', signal, 15000));
  if (!object(status) || status.loggedIn !== true || status.authMethod !== 'claude.ai')
    throw new HelperError('CLAUDE_ACCOUNT_LOGIN_REQUIRED', 401);
  return { authenticated: true };
}
function validatedRequest(body, models) {
  if (
    !object(body) ||
    !models.includes(body.model) ||
    typeof body.instructions !== 'string' ||
    !Array.isArray(body.input) ||
    !Array.isArray(body.tools) ||
    Object.keys(body).some(
      (key) =>
        !['model', 'instructions', 'input', 'tools', 'stream', 'store', 'reasoning'].includes(key),
    ) ||
    body.tools.some(
      (tool) => !object(tool) || tool.type !== 'function' || typeof tool.name !== 'string',
    ) ||
    body.input.some(
      (item) =>
        !object(item) || !['message', 'function_call', 'function_call_output'].includes(item.type),
    )
  )
    throw new HelperError('INVALID_REQUEST', 400);
  const pending = new Set();
  const seen = new Set();
  for (const item of body.input) {
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || seen.has(item.call_id))
        throw new HelperError('INVALID_TOOL_PAIRING', 400);
      seen.add(item.call_id);
      pending.add(item.call_id);
    } else if (item.type === 'function_call_output' && !pending.delete(item.call_id)) {
      throw new HelperError('INVALID_TOOL_PAIRING', 400);
    }
  }
  if (pending.size) throw new HelperError('INVALID_TOOL_PAIRING', 400);
  return body;
}
function portableResponse(result, body) {
  if (
    !object(result) ||
    result.type !== 'result' ||
    result.is_error === true ||
    result.subtype !== 'success' ||
    !object(result.structured_output)
  )
    throw new HelperError('INCOMPLETE_CLAUDE_RESPONSE');
  const value = result.structured_output;
  if (
    typeof value.text !== 'string' ||
    !Array.isArray(value.tool_calls) ||
    value.tool_calls.length > 64
  )
    throw new HelperError('INVALID_CLAUDE_RESPONSE');
  const output = [];
  if (value.text)
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: value.text }],
    });
  for (const call of value.tool_calls) {
    if (
      !object(call) ||
      typeof call.arguments !== 'string' ||
      !body.tools.some((tool) => tool.name === call.name) ||
      !object(json(call.arguments))
    )
      throw new HelperError('INVALID_CLAUDE_TOOL_CALL');
    output.push({
      type: 'function_call',
      call_id: randomUUID(),
      name: call.name,
      arguments: call.arguments,
    });
  }
  if (!output.length) throw new HelperError('EMPTY_CLAUDE_RESPONSE');
  return { status: 'completed', output };
}

/** Loopback-only, authenticated helper. Only these fixed operations can launch the official CLI. */
export function createClaudeHelper({ pairingToken, models = ['sonnet', 'opus', 'haiku'], run }) {
  if (
    typeof pairingToken !== 'string' ||
    pairingToken.length < 32 ||
    !/^[a-zA-Z0-9_-]+$/u.test(pairingToken)
  )
    throw new Error('Invalid pairing token');
  if (!Array.isArray(models) || !models.length || models.length > 32)
    throw new Error('Invalid model list');
  models.forEach((model) => generationArguments(model));
  let busy = false;
  const expected = Buffer.from('Bearer ' + pairingToken);
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const respond = (status, value) => {
      if (!res.destroyed) {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      }
    };
    const received = Buffer.from(req.headers.authorization ?? '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      respond(401, { error: { code: 'PAIRING_REQUIRED' } });
      return;
    }
    if (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/u.test(req.headers.origin)) {
      respond(403, { error: { code: 'ORIGIN_DENIED' } });
      return;
    }
    if (
      ![
        'GET /v1/models',
        'POST /v1/responses',
        'POST /v1/auth/login',
        'POST /v1/auth/logout',
        'POST /v1/auth/status',
      ].includes(req.method + ' ' + req.url)
    ) {
      respond(404, { error: { code: 'NOT_FOUND' } });
      return;
    }
    if (busy) {
      respond(409, { error: { code: 'HELPER_BUSY' } });
      return;
    }
    busy = true;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) throw new HelperError('REQUEST_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      const source = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/v1/auth/login') {
        await run(['auth', 'login'], '', controller.signal, 180000);
        respond(200, await account(run, controller.signal));
      } else if (req.url === '/v1/auth/logout') {
        await run(['auth', 'logout'], '', controller.signal, 15000);
        respond(200, { authenticated: false });
      } else if (req.url === '/v1/auth/status') respond(200, await account(run, controller.signal));
      else if (req.url === '/v1/models') {
        await account(run, controller.signal);
        respond(200, { data: models.map((id) => ({ id })) });
      } else {
        const body = validatedRequest(json(source), models);
        await account(run, controller.signal);
        const input =
          'Act as the model for Loom. The following JSON is the complete conversation and available remote tools. Do not perform actions locally. Return text and any requested tool_calls using exact declared names and JSON-encoded arguments; Loom executes those calls and supplies their results in the next request. Preserve completed tool results and do not request an action already completed.\n' +
          JSON.stringify(body);
        const result = json(await run(generationArguments(body.model), input, controller.signal));
        respond(200, portableResponse(result, body));
      }
    } catch (error) {
      respond(error instanceof HelperError ? error.status : 502, {
        error: { code: error instanceof HelperError ? error.code : 'HELPER_FAILED' },
      });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pairingToken = randomBytes(32).toString('base64url');
  const binary = process.env.LOOM_CLAUDE_BINARY || 'claude';
  const port = Number(process.env.LOOM_CLAUDE_HELPER_PORT || 43187);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid helper port');
  const models = (process.env.LOOM_CLAUDE_MODELS || 'sonnet,opus,haiku')
    .split(',')
    .map((value) => value.trim());
  const server = createClaudeHelper({
    pairingToken,
    models,
    run: (args, input, signal, timeout) => runClaude(binary, args, input, signal, timeout),
  });
  server.on('error', () => {
    process.stderr.write('Could not start the loopback helper. Check the port.\n');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(
      `Loom Claude helper: http://127.0.0.1:${port}/v1/\nPairing token (paste into Companion only): ${pairingToken}\nClaude Code handles account sign-in. Stop this helper to invalidate its pairing token.\n`,
    );
  });
}
