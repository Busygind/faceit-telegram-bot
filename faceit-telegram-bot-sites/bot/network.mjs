/** workerd supports follow/manual, but rejects redirect:error before any I/O. */
export async function fetchWithoutRedirects(fetch, url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'manual' });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* No body data is needed. */ }
    throw new Error('CLOUD_REDIRECT_REJECTED');
  }
  return response;
}
