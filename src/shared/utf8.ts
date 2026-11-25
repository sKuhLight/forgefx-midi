/**
 * Strict UTF-8 encode/decode for the file containers.
 *
 * The protocol's text fields (preset / cab names, XML attributes) are UTF-8.
 * These helpers are deliberately strict: a malformed, overlong, surrogate or
 * truncated sequence throws instead of being replaced. Pure code — no
 * `TextDecoder`, no Node built-ins, so the file layer stays browser-safe.
 */

function bad(what: string, offset: number): never {
  throw new Error(`${what}: invalid UTF-8 at byte ${offset}`);
}

/** Decode a complete UTF-8 byte range. Throws on any malformed sequence. */
export function decodeUtf8(bytes: Uint8Array, what = 'UTF-8'): string {
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      parts.push(String.fromCharCode(b0));
      i += 1;
      continue;
    }
    let needed: number;
    let cp: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      needed = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      needed = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      needed = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      bad(what, i);
    }
    if (i + needed >= bytes.length) {
      bad(what, i);
    }
    for (let k = 1; k <= needed; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) bad(what, i + k);
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) bad(what, i);
    parts.push(String.fromCodePoint(cp));
    i += needed + 1;
  }
  return parts.join('');
}

/**
 * Encode a string as UTF-8. Throws on a lone surrogate (a JS string can hold
 * one, but it is not valid Unicode text).
 */
export function encodeUtf8(text: string, what = 'UTF-8'): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i) as number;
    if (cp > 0xffff) {
      i += 1;
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new Error(`${what}: lone surrogate at code unit ${i}`);
    } else if (cp > 0x10ffff) {
      throw new Error(`${what}: code point out of range at code unit ${i}`);
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}
