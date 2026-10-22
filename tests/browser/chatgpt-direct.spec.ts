import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const issuer = 'https://auth.openai.com';
const api = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'loom-browser-test',
  alg: 'RS256',
  use: 'sig',
};

function signedIdentity(nonce: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${encode({
    iss: issuer,
    aud: 'oaiapp_loom_browser_fixture',
    sub: 'browser-fixture-subject',
    email: 'browser-fixture@example.test',
    name: 'Browser Fixture',
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

for (const blockedDiscovery of [false, true]) {
  test(
    blockedDiscovery
      ? 'keeps callback verification failure visible and reuses the issued registration'
      : 'signs in, discovers models, and streams directly without an extension or token backend',
    async ({ page, context }) => {
      const server = spawn(process.execPath, [resolve('scripts/serve-chatgpt-browser.mjs')], {
        env: { ...process.env, LOOM_BROWSER_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const url = await new Promise<string>((accept, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Static test server did not start.')),
          10_000,
        );
        server.once('error', reject);
        server.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match =
            /http:\/\/127\.0\.0\.1:\d+\/example-codex-experimental\/workbench\.html/u.exec(output);
          if (match) {
            clearTimeout(timeout);
            accept(match[0]);
          }
        });
        server.once('exit', () => {
          clearTimeout(timeout);
          reject(new Error('Static test server exited.'));
        });
      });
      const origin = new URL(url).origin;
      const localRequests: { method: string; url: string; body: string | null }[] = [];
      const tokenForms: URLSearchParams[] = [];
      const responseRequests: Record<string, unknown>[] = [];
      const authorizationRequests: URL[] = [];
      let currentNonce = '';
      let revoked = false;
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      };
      context.on('request', (request) => {
        if (request.url().startsWith(origin)) {
          localRequests.push({
            method: request.method(),
            url: request.url(),
            body: request.postData(),
          });
        }
      });
      try {
        await context.route(`${issuer}/**`, async (route) => {
          const request = route.request();
          const target = new URL(request.url());
          if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: cors });
          } else if (target.pathname === '/api/accounts/authorize') {
            authorizationRequests.push(target);
            currentNonce = target.searchParams.get('nonce') ?? '';
            expect(target.searchParams.get('code_challenge_method')).toBe('S256');
            expect(target.searchParams.get('scope')).toBe(scopes);
            expect(target.searchParams.get('resource')).toBe(api);
            const callback = new URL(target.searchParams.get('redirect_uri') ?? '');
            expect(callback.origin).toBe(origin);
            expect(callback.pathname).toBe('/auth/callback');
            callback.search = new URLSearchParams({
              code: 'fixture-authorization-code',
              state: target.searchParams.get('state') ?? '',
              client_id: 'oaiapp_loom_browser_fixture',
            }).toString();
            await route.fulfill({ status: 302, headers: { location: callback.href } });
          } else if (target.pathname === '/api/accounts/oauth/token') {
            const form = new URLSearchParams(request.postData() ?? '');
            tokenForms.push(form);
            expect(form.get('client_id')).toBe('oaiapp_loom_browser_fixture');
            expect(form.has('client_secret')).toBe(false);
            await route.fulfill({
              json: {
                access_token: 'fixture-browser-access-token',
                refresh_token: 'fixture-browser-refresh-token',
                id_token: signedIdentity(currentNonce),
                token_type: 'Bearer',
                expires_in: 3600,
                scope: scopes,
              },
              headers: cors,
            });
          } else if (target.pathname === '/.well-known/openid-configuration') {
            if (blockedDiscovery) {
              await route.abort('failed');
              return;
            }
            await route.fulfill({
              json: {
                issuer,
                authorization_endpoint: issuer + '/api/accounts/authorize',
                token_endpoint: issuer + '/api/accounts/oauth/token',
                jwks_uri: issuer + '/.well-known/jwks.json',
                revocation_endpoint: issuer + '/api/accounts/oauth/revoke',
              },
              headers: cors,
            });
          } else if (target.pathname === '/.well-known/jwks.json') {
            await route.fulfill({ json: { keys: [jwk] }, headers: cors });
          } else if (target.pathname === '/api/accounts/oauth/revoke') {
            revoked = true;
            expect(new URLSearchParams(request.postData() ?? '').get('token')).toBe(
              'fixture-browser-refresh-token',
            );
            await route.fulfill({ status: 200, body: '', headers: cors });
          } else throw new Error(`Unexpected auth fixture path: ${target.pathname}`);
        });
        await context.route(`${api}/**`, async (route) => {
          const request = route.request();
          if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: cors });
            return;
          }
          expect(request.headers().authorization).toBe('Bearer fixture-browser-access-token');
          if (new URL(request.url()).pathname === '/v1/models') {
            await route.fulfill({
              json: {
                models: [
                  {
                    slug: 'fixture-visible',
                    display_name: 'Browser fixture model',
                    visibility: 'list',
                  },
                  { slug: 'fixture-hidden', display_name: 'Hidden fixture', visibility: 'hidden' },
                ],
              },
              headers: cors,
            });
          } else {
            expect(request.url()).toBe(api + '/responses');
            const body = request.postDataJSON() as Record<string, unknown>;
            responseRequests.push(body);
            expect(body.store).toBe(false);
            expect(body.stream).toBe(true);
            expect(Array.isArray(body.input)).toBe(true);
            await route.fulfill({
              headers: { ...cors, 'content-type': 'text/event-stream' },
              body:
                'data: {"type":"response.output_text.delta","delta":"Browser-only login test OK."}\n\n' +
                'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Browser-only login test OK."}]}]}}\n\n',
            });
          }
        });
        // Any accidental old extension/backend route is a test failure, not live provider traffic.
        await context.route('https://chatgpt.com/backend-api/**', () => {
          throw new Error('Old Codex backend used.');
        });
        await page.goto(url);
        await expect(page.locator('#model-provider')).toHaveCount(0);
        await expect(page.locator('#extension-id')).toHaveCount(0);
        await expect(page.locator('#chatgpt-account')).toBeHidden();
        await expect(page.locator('#chatgpt-sign-out')).toBeHidden();
        await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
        if (blockedDiscovery) {
          const failure = page.locator('#chatgpt-error');
          await expect(failure).toContainText('could not load OpenAI sign-in configuration');
          await expect(failure).toBeInViewport();
          await expect(page.locator('#chatgpt-account')).toHaveValue('oaiapp_loom_browser_fixture');
          await expect(page.locator('#chatgpt-account')).toContainText('sign-in incomplete');
          await expect(page.locator('#run')).toBeDisabled();
          await expect.poll(() => context.pages().length).toBe(1);
          await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
          await expect.poll(() => authorizationRequests.length).toBe(2);
          expect(authorizationRequests[1]?.searchParams.get('client_id')).toBe(
            'oaiapp_loom_browser_fixture',
          );
          await expect(failure).toContainText('could not load OpenAI sign-in configuration');
          await expect(page.locator('#chatgpt-account option')).toHaveCount(2);
          const storage = await page.evaluate(() =>
            JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
          );
          expect(storage).not.toContain('fixture-browser-access-token');
          expect(storage).not.toContain('fixture-browser-refresh-token');
          expect(storage).not.toContain('fixture-authorization-code');
          expect(responseRequests).toHaveLength(0);
          return;
        }
        await expect(page.locator('#chatgpt-status')).toContainText('browser-fixture@example.test');
        await expect(page.locator('#chatgpt-status')).not.toContainText('oaiapp');
        await expect(page.locator('#chatgpt-account')).not.toContainText('oaiapp');
        await expect(page.locator('#available-models')).toContainText('Browser fixture model');
        await expect(page.locator('#available-models')).not.toContainText('Hidden fixture');
        await expect(page.locator('#model')).toHaveValue('fixture-visible');
        await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await page.locator('#workspace-mode').selectOption('memory');
        await page.locator('#open-workspace').click();
        await page.locator('#prompt').fill('Reply with Browser-only login test OK.');
        await page.locator('#run').click();
        await expect(page.locator('#log')).toContainText('Browser-only login test OK.');
        await expect(page.locator('#status')).toHaveText('Run complete.');
        expect(responseRequests).toHaveLength(1);
        expect(tokenForms).toHaveLength(1);
        expect(authorizationRequests[0]?.searchParams.get('client_id')).toBe(
          'dynamic_agent_client',
        );

        const storage = await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        );
        expect(storage).not.toContain('fixture-browser-access-token');
        expect(storage).not.toContain('fixture-browser-refresh-token');
        expect(storage).not.toContain('fixture-authorization-code');
        expect(storage).not.toContain('eyJhbGci');
        expect(localRequests.every((request) => request.method === 'GET')).toBe(true);
        expect(JSON.stringify(localRequests)).not.toContain('fixture-browser-access-token');
        expect(JSON.stringify(localRequests)).not.toContain('fixture-browser-refresh-token');
        expect(output).not.toContain('fixture-authorization-code');

        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect.poll(() => revoked).toBe(true);
        await expect(page.locator('#run')).toBeDisabled();
        await page.reload();
        await expect(
          page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }),
        ).toBeVisible();
        await expect(page.locator('#run')).toBeDisabled();
      } finally {
        server.kill('SIGTERM');
        await new Promise<void>((accept) => {
          if (server.exitCode !== null) accept();
          else server.once('exit', () => accept());
        });
      }
    },
  );
}
