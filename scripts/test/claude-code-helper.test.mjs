import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createClaudeHelper, generationArguments, runClaude } from '../claude-code-helper.mjs';
const token = 'fixture_only_pairing_token_1234567890';
const status = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
const result = (text, tool_calls = []) =>
  JSON.stringify({ type: 'result', subtype: 'success', structured_output: { text, tool_calls } });
const body = {
  model: 'sonnet',
  instructions: '',
  input: [{ type: 'message', role: 'user', content: 'Hello' }],
  tools: [{ type: 'function', name: 'lookup' }],
};
async function fixture(t, run) {
  const server = createClaudeHelper({ pairingToken: token, run });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return (path, data, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
}
test('pairing and origin checks do not launch CLI', async (t) => {
  const request = await fixture(t, () => {
    throw new Error('must not run');
  });
  assert.equal((await request('models', undefined, { authorization: 'bad' })).status, 401);
  assert.equal(
    (await request('models', undefined, { origin: 'https://website.example' })).status,
    403,
  );
  assert.equal((await request('other')).status, 404);
});
test('login, catalogue and generation preserve completed tool results without replay', async (t) => {
  const generations = [];
  const request = await fixture(t, async (args, input) => {
    if (args[0] === 'auth') return status;
    generations.push(input);
    return generations.length === 1
      ? result('', [{ name: 'lookup', arguments: '{}' }])
      : result('Done');
  });
  assert.equal((await request('auth/login', {})).status, 200);
  assert.equal((await (await request('models')).json()).data.length, 3);
  const first = await (await request('responses', body)).json();
  const call = first.output[0];
  const continuation = {
    ...body,
    input: [
      ...body.input,
      call,
      { type: 'function_call_output', call_id: call.call_id, output: 'already completed' },
    ],
  };
  assert.equal((await request('responses', continuation)).status, 200);
  assert.equal(generations.length, 2);
  assert.ok(generations[1].includes('already completed'));
  assert.equal((await request('responses', { ...body, input: [call] })).status, 400);
  assert.equal(generations.length, 2);
  assert.equal((await request('auth/logout', {})).status, 200);
});
test('malformed output and underlying exceptions are sanitized', async (t) => {
  let output = 'raw secret prompt';
  const request = await fixture(t, async (args) => {
    if (args[0] === 'auth') return status;
    if (output === 'throw') throw new Error('secret credential');
    return output;
  });
  let response = await request('responses', body);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'INVALID_CLAUDE_RESPONSE');
  output = 'throw';
  assert.deepEqual(await (await request('responses', body)).json(), {
    error: { code: 'HELPER_FAILED' },
  });
});
test('generation disables local tools and MCP', () => {
  const args = generationArguments('sonnet');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.throws(() => generationArguments('--dangerous'));
});
test('subprocess cancellation and deadline return safe errors', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runClaude(process.execPath, [], '', controller.signal), {
    code: 'CANCELLED',
  });
  await assert.rejects(
    runClaude(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      '',
      new AbortController().signal,
      20,
    ),
    { code: 'DEADLINE_EXCEEDED' },
  );
});
