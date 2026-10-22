import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChatGPTBrowserServer } from '../serve-chatgpt-browser.mjs';

test('serves only static browser assets and never implements credential endpoints', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-static-chatgpt-'));
  const root = join(directory, 'public');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'workbench.html'), '<h1>Workbench</h1>');
  await writeFile(join(root, 'chatgpt-callback.html'), '<h1>Browser callback</h1>');
  await writeFile(join(directory, 'private.json'), 'private');
  await symlink(join(directory, 'private.json'), join(root, 'dist', 'escape.json'));
  const { server, origin } = await createChatGPTBrowserServer({ root, port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });

  const home = await fetch(origin, { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/example-codex-experimental/workbench.html');
  const callback = await fetch(origin + '/auth/callback?code=fixture-code&state=fixture-state');
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), '<h1>Browser callback</h1>');
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(callback.headers.get('set-cookie'), null);
  assert.equal(callback.headers.get('access-control-allow-origin'), null);

  for (const path of [
    '/api/chatgpt/status',
    '/example-codex-experimental/dist/escape.json',
    '/example-codex-experimental/%2e%2e%2fprivate.json',
    '/example-codex-experimental/src/main.ts',
    '/example-codex-experimental/.env',
  ]) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal(
    (await fetch(origin + '/auth/callback', { method: 'POST', body: 'fixture' })).status,
    405,
  );
  assert.equal((await fetch(origin + '/auth/callback', { method: 'HEAD' })).status, 200);
  const wrongHost = await new Promise((done, reject) => {
    const outgoing = request(origin, { headers: { Host: 'untrusted.example' } }, (response) => {
      response.resume();
      done(response.statusCode);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(wrongHost, 403);
});
