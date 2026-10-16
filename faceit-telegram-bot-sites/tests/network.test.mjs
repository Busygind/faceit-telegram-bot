import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithoutRedirects } from '../bot/network.mjs';
test('cloud transport overrides Node redirect:error with workerd manual mode', async () => {
  let count = 0;
  const fetch = async (url, options) => { count++; assert.equal(options.redirect, 'manual'); assert.equal(url, 'https://example.test'); return Response.json({ ok: true }); };
  const response = await fetchWithoutRedirects(fetch, 'https://example.test', { redirect: 'error' });
  assert.equal(response.status, 200); assert.equal(count, 1);
});
test('cloud transport rejects redirects without following Location or exposing the target', async () => {
  let count = 0;
  const fetch = async () => { count++; return new Response('', { status: 302, headers: { location: 'https://other.test/private-secret' } }); };
  await assert.rejects(fetchWithoutRedirects(fetch, 'https://example.test'), { message: 'CLOUD_REDIRECT_REJECTED' }); assert.equal(count, 1);
});
