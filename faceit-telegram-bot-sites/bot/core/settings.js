// Non-secret defaults. scripts/configure.mjs creates ignored private-settings.js.
export const DEFAULT_SETTINGS = Object.freeze({
  allowedChatIds: [],
  faceitKey: '',
  encryptionKeyHex: '',
  encryptionKeyId: '',
  maxRequests: 8,
});

export function validateSettings(settings) {
  if (!Array.isArray(settings.allowedChatIds)
      || !settings.allowedChatIds.every((id) => Number.isSafeInteger(id) && id < 0)) {
    throw new Error('CONFIG_CHAT_IDS');
  }
  if (typeof settings.faceitKey !== 'string' || settings.faceitKey.length < 16
      || /\s/.test(settings.faceitKey)) throw new Error('CONFIG_FACEIT_KEY');
  if (!/^[a-f0-9]{64}$/i.test(settings.encryptionKeyHex)) throw new Error('CONFIG_ENCRYPTION_KEY');
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(settings.encryptionKeyId)) throw new Error('CONFIG_KEY_ID');
  if (!Number.isInteger(settings.maxRequests) || settings.maxRequests < 2 || settings.maxRequests > 16) {
    throw new Error('CONFIG_BUDGET');
  }
  return settings;
}
