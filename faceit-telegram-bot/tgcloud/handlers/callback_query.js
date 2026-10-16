import { createRuntime } from '../lib/runtime.js';
export default async function (query, ctx) {
  return createRuntime().handleCallback(query, ctx);
}
