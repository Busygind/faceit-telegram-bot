import { createRuntime } from '../lib/runtime.js';
export default async function (message, ctx) {
  return createRuntime().handleMessage(message, ctx);
}
