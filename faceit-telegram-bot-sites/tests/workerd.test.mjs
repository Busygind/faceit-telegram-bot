import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, createFetchMock } from 'miniflare';

// Exercise the real deployment helper in workerd, not Node's more permissive
// fetch implementation. MockAgent disables all external network connections.
test('real workerd accepts cloud transport and rejects redirects without following', async t => {
  const helper = await readFile(new URL('../bot/network.mjs', import.meta.url), 'utf8');
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const upstream = fetchMock.get('https://upstream.example');
  upstream.intercept({ path: '/ok' }).reply(200, 'synthetic-ok');
  upstream.intercept({ path: '/redirect' }).reply(302, '', { headers: { location: 'https://must-not-follow.example/target' } });
  const worker = new Miniflare({
    modules: true,
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    // Miniflare's built-in fetchMock loopback defaults its Node sub-fetch to
    // follow. Keep that bridge manual too, so workerd itself sees the 302.
    outboundService: request => globalThis.fetch(request.url, { redirect: 'manual', dispatcher: fetchMock }),
    script: `${helper}\nexport default { async fetch(request) {
      const path = new URL(request.url).pathname;
      try {
        const response = await fetchWithoutRedirects(fetch, 'https://upstream.example' + path,
          { redirect: 'error', cache: 'no-store', credentials: 'omit' });
        return Response.json({ ok: true, status: response.status, body: await response.text() });
      } catch (error) { return Response.json({ ok: false, code: error.message }); }
    } };`,
  });
  t.after(async () => { await worker.dispose(); await fetchMock.close(); });
  assert.deepEqual(await (await worker.dispatchFetch('https://worker.example/ok')).json(),
    { ok: true, status: 200, body: 'synthetic-ok' });
  assert.deepEqual(await (await worker.dispatchFetch('https://worker.example/redirect')).json(),
    { ok: false, code: 'CLOUD_REDIRECT_REJECTED' });
  fetchMock.assertNoPendingInterceptors();
});

test('real workerd rejects the former redirect:error option before network I/O', async t => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({
    modules: true,
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    fetchMock,
    script: `export default { async fetch() {
      try { await fetch('https://never-requested.example/old', { redirect: 'error' });
        return Response.json({ rejected: false });
      } catch (error) { return Response.json({ rejected: true, message: error.message }); }
    } };`,
  });
  t.after(async () => { await worker.dispose(); await fetchMock.close(); });
  const result = await (await worker.dispatchFetch('https://worker.example/old')).json();
  assert.equal(result.rejected, true);
  assert.match(result.message, /Invalid redirect value.*(?:follow|manual)/i);
});
