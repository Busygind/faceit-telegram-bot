import { gcmsiv } from './vendor/noble-gcmsiv.js';

const MAX_ENVELOPE_LENGTH = 60000;
const MAX_VERSION = 0xffffffff;

export class CredentialsError extends Error {
  constructor() {
    super('TeamSpeak credentials could not be processed safely.');
    this.name = 'CredentialsError';
  }
}

function hexToBytes(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]*$/i.test(value)) {
    throw new CredentialsError();
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}

// The platform does not document TextEncoder/TextDecoder. Avoid depending on
// browser/Node globals: only ECMAScript strings and Uint8Array are required.
function encodeUtf8(value) {
  const bytes = [];
  for (const character of value) {
    let code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes) {
  let value = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first < 0x80) {
      value += String.fromCodePoint(first);
      continue;
    }
    const size = first >= 0xc2 && first <= 0xdf ? 2
      : first >= 0xe0 && first <= 0xef ? 3
        : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (!size || index + size - 1 > bytes.length) throw new CredentialsError();
    let code = first & (0x7f >> size);
    for (let offset = 1; offset < size; offset += 1) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) throw new CredentialsError();
      code = (code << 6) | (next & 0x3f);
    }
    if (code < (size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000)
      || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new CredentialsError();
    }
    value += String.fromCodePoint(code);
  }
  return value;
}

function normalizedChatId(chatId) {
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new CredentialsError();
  }
  return String(chatId);
}

function nonceFor(chatId, version) {
  normalizedChatId(chatId);
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new CredentialsError();
  }
  const bytes = new Uint8Array(12);
  let id = BigInt.asUintN(64, BigInt(chatId));
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(id & 0xffn);
    id >>= 8n;
  }
  for (let index = 0; index < 4; index += 1) {
    bytes[8 + index] = (version >>> (index * 8)) & 0xff;
  }
  return bytes;
}

/**
 * Seal settings using a deployment-specific, locally generated 256-bit key.
 *
 * The caller must allocate an increasing version atomically for each chat.
 * GCMSIV is intentionally used instead of GCM: accidental version rollback
 * does not produce GCM's catastrophic nonce-reuse failure. No runtime CSPRNG,
 * WebCrypto, filesystem, Node API, or npm package is required.
 */
export function createSealer({ keyHex, keyId } = {}) {
  if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(keyHex)
    || typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new CredentialsError();
  }
  const key = hexToBytes(keyHex);
  const additionalData = (chatId) => encodeUtf8(
    `faceit-telegram-bot:teamspeak:v1:${keyId}:${normalizedChatId(chatId)}`,
  );

  return Object.freeze({
    seal(chatId, host, password, version) {
      if (typeof host !== 'string' || !host.length || host.length > 512
        || typeof password !== 'string' || password.length > 4096) {
        throw new CredentialsError();
      }
      const nonce = nonceFor(chatId, version);
      const plain = encodeUtf8(JSON.stringify({ host, password }));
      try {
        const encrypted = gcmsiv(key, nonce, additionalData(chatId)).encrypt(plain);
        return JSON.stringify({ v: 1, k: keyId, n: bytesToHex(nonce), c: bytesToHex(encrypted) });
      } catch {
        throw new CredentialsError();
      } finally {
        plain.fill(0);
      }
    },

    open(chatId, sealed) {
      let plain;
      try {
        if (typeof sealed !== 'string' || sealed.length > MAX_ENVELOPE_LENGTH) {
          throw new CredentialsError();
        }
        const envelope = JSON.parse(sealed);
        if (!envelope || envelope.v !== 1 || envelope.k !== keyId
          || typeof envelope.n !== 'string' || envelope.n.length !== 24
          || typeof envelope.c !== 'string' || envelope.c.length < 32) {
          throw new CredentialsError();
        }
        const nonce = hexToBytes(envelope.n);
        const expectedPrefix = nonceFor(chatId, 1);
        for (let index = 0; index < 8; index += 1) {
          if (nonce[index] !== expectedPrefix[index]) throw new CredentialsError();
        }
        if (nonce.slice(8).every((byte) => byte === 0)) throw new CredentialsError();
        plain = gcmsiv(key, nonce, additionalData(chatId)).decrypt(hexToBytes(envelope.c));
        const value = JSON.parse(decodeUtf8(plain));
        if (!value || typeof value.host !== 'string' || !value.host.length
          || value.host.length > 512 || typeof value.password !== 'string'
          || value.password.length > 4096) {
          throw new CredentialsError();
        }
        return { host: value.host, password: value.password };
      } catch {
        throw new CredentialsError();
      } finally {
        plain?.fill(0);
      }
    },
  });
}
