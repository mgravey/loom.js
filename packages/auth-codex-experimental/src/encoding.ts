import { CodexExperimentalAuthError } from './errors.js';

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    result += BASE64_URL_ALPHABET[(value >>> 18) & 63] ?? '';
    result += BASE64_URL_ALPHABET[(value >>> 12) & 63] ?? '';
    if (index + 1 < bytes.length) result += BASE64_URL_ALPHABET[(value >>> 6) & 63] ?? '';
    if (index + 2 < bytes.length) result += BASE64_URL_ALPHABET[value & 63] ?? '';
  }
  return result;
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new CodexExperimentalAuthError('INVALID_RESPONSE', 'Token encoding is invalid.');
  }
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64_URL_ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  try {
    return decodeURIComponent(
      Array.from(bytes, (value) => `%${value.toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    throw new CodexExperimentalAuthError('INVALID_RESPONSE', 'Token payload is invalid UTF-8.');
  }
}

export function asciiBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      throw new CodexExperimentalAuthError('INVALID_PKCE', 'PKCE data must be ASCII.');
    }
    result[index] = code;
  }
  return result;
}

export function formEncode(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export function queryParameters(value: string): Readonly<Record<string, string>> {
  const parameters: Record<string, string> = {};
  if (value.length === 0) return parameters;
  for (const field of value.split('&')) {
    const separator = field.indexOf('=');
    const rawKey = separator < 0 ? field : field.slice(0, separator);
    const rawValue = separator < 0 ? '' : field.slice(separator + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/gu, ' '));
      const decoded = decodeURIComponent(rawValue.replace(/\+/gu, ' '));
      if (!(key in parameters)) parameters[key] = decoded;
    } catch {
      throw new CodexExperimentalAuthError('INVALID_CALLBACK', 'OAuth callback is malformed.');
    }
  }
  return parameters;
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
