import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramApi, TelegramApiError } from '../local/telegram.mjs';

for (const [name, create] of [['local', createTelegramApi]]) {
  test(name + ' unpin cleanup recognizes only safe explicit absent-target errors without retaining descriptions', async () => {
    const token = '123456:' + 'fixture_'.repeat(4);
    for (const [code, description, expected] of [
      [400, 'Bad Request: message to unpin not found', true],
      [400, 'Bad Request: message is not pinned', true],
      [400, 'Bad Request: not enough rights to unpin a message', false],
      [403, 'Bad Request: message is not pinned', false],
      [429, 'Bad Request: message is not pinned', false],
      [500, 'Bad Request: message is not pinned', false],
    ]) {
      const api = create({ token, fetch: async () => Response.json({ ok: false, error_code: code, description }, { status: code }) });
      await assert.rejects(api.unpinChatMessage({ chat_id: -10, message_id: 5 }), error => {
        assert.equal(error.unpinTargetMissing, expected);
        assert.equal(error.description, undefined);
        assert.ok(!error.message.includes(description));
        assert.throws(() => { error.unpinTargetMissing = !expected; });
        return true;
      });
      await assert.rejects(api.sendMessage({ chat_id: -10, text: 'fixture' }), error => error.unpinTargetMissing === false);
    }
    assert.equal(new TelegramApiError({ code: 403, unpinTargetMissing: true }).unpinTargetMissing, false);
  });
}
