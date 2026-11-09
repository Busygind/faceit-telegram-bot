export class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const DEFAULT_VOICE_PORT = 9987;

function validIpv6(value) {
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half ? half.split(':') : []);
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

export function validateAddress(address) {
  if (typeof address !== 'string' || !address || address.length > 270 || /[\s\x00-\x1f\x7f]/.test(address)) {
    throw new InputError('TS_ADDRESS');
  }
  if (!address.startsWith('[') && address.split(':').length > 2) {
    if (!validIpv6(address)) throw new InputError('TS_ADDRESS');
    return `[${address.toLowerCase()}]:${DEFAULT_VOICE_PORT}`;
  }
  const match = /^(\[[0-9a-f:]+\]|[^\s/:?#@\[\]]+)(?::(\d{1,5}))?$/i.exec(address);
  const port = match?.[2] == null ? DEFAULT_VOICE_PORT : +match[2];
  if (!match || port < 1 || port > 65535) throw new InputError('TS_ADDRESS');
  const host = match[1];
  if (host.startsWith('[')) {
    if (!validIpv6(host.slice(1, -1))) throw new InputError('TS_ADDRESS');
  } else if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && +part <= 255)) {
      throw new InputError('TS_ADDRESS');
    }
  } else if (host.length > 253 || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new InputError('TS_ADDRESS');
  }
  return `${host.toLowerCase()}:${port}`;
}

// Validate before hiding the standard suffix: the final group of an unbracketed
// IPv6 address can itself be 9987 and must never be mistaken for a connection setting.
export function displayTeamspeakAddress(address) {
  let normalized;
  try { normalized = validateAddress(address); }
  catch (error) {
    if (error instanceof InputError) return address;
    throw error;
  }
  const standardSuffix = `:${DEFAULT_VOICE_PORT}`;
  return normalized.endsWith(standardSuffix) ? normalized.slice(0, -standardSuffix.length) : normalized;
}

export function parseTeamspeak(args) {
  const noPassword = /^--no-password[ \t]+(\S+)[ \t]*$/.exec(args);
  if (noPassword) return { host: validateAddress(noPassword[1]), password: '' };
  const match = /^(\S+)[ \t]+([^\r\n]+)$/.exec(args);
  if (!match || match[1].startsWith('--') || match[2].length > 512 || /[\x00-\x1f\x7f]/.test(match[2]) || !match[2].trim()) {
    throw new InputError('TS_SYNTAX');
  }
  return { host: validateAddress(match[1]), password: match[2] };
}
