export class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validIpv6(value) {
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return false;
  const compressed = value.includes('::');
  if (value.includes(':::') || value.split('::').length > 2) return false;
  const groups = value.split(':').filter(Boolean);
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  if (compressed) return groups.length < 8;
  return groups.length === 8 && !value.startsWith(':') && !value.endsWith(':');
}

export function validateAddress(address) {
  if (address.length > 270) throw new InputError('TS_ADDRESS');
  const match = /^(\[[0-9a-f:]+\]|[^\s/:?#@]+):(\d{1,5})$/i.exec(address);
  if (!match || +match[2] < 1 || +match[2] > 65535) throw new InputError('TS_ADDRESS');
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
  return `${host.toLowerCase()}:${+match[2]}`;
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
