/**
 * Strict, dependency-free XML reader/writer for the offline file containers.
 *
 * Scope is deliberately the subset those files use: elements, attributes and
 * character data. There is no DTD, no CDATA, no custom entity and no
 * namespace/processing-instruction support. `<!DOCTYPE …>` is rejected before
 * anything else, so an "entity expansion" payload can never reach a decoder;
 * only the five predefined entities and numeric character references decode.
 *
 * Every parse is bounded by `XmlLimits`: input length, nesting depth, element
 * count, per-element attribute count, name/value/text lengths. A malformed or
 * oversized document throws; no partial tree is returned.
 */

import { decodeUtf8, encodeUtf8 } from './utf8.js';

export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

export interface XmlElement {
  readonly name: string;
  readonly attributes: XmlAttribute[];
  readonly children: XmlElement[];
  /** Direct character data of this element (child elements excluded). */
  readonly text: string;
}

export interface XmlLimits {
  maxBytes: number;
  /** Maximum number of nested element levels; the root element is level 1. */
  maxDepth: number;
  maxElements: number;
  maxAttributes: number;
  maxNameLength: number;
  maxValueLength: number;
  maxTextLength: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxBytes: 1024 * 1024,
  maxDepth: 32,
  maxElements: 10_000,
  maxAttributes: 32,
  maxNameLength: 64,
  maxValueLength: 4096,
  maxTextLength: 64 * 1024,
};

function isXmlWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

export function isWhitespaceText(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isXmlWhitespace(text[i])) return false;
  return true;
}

function assertXmlName(name: string, maxLength: number, what: string): void {
  if (name.length === 0) throw new Error(`${what}: empty XML name`);
  if (name.length > maxLength) throw new Error(`${what}: XML name is ${name.length} characters (maximum ${maxLength})`);
  const first = name.charCodeAt(0);
  const isLetter = (c: number): boolean =>
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
  const isNameChar = (c: number): boolean =>
    isLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e;
  if (!isLetter(first)) throw new Error(`${what}: invalid first character in XML name ${JSON.stringify(name)}`);
  for (let i = 1; i < name.length; i++) {
    if (!isNameChar(name.charCodeAt(i))) {
      throw new Error(`${what}: invalid character at ${i} in XML name ${JSON.stringify(name)}`);
    }
  }
}

function assertXmlChar(code: number, what: string): void {
  if (code === 0) throw new Error(`${what}: NUL character is not allowed`);
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    throw new Error(`${what}: control character U+${code.toString(16).padStart(4, '0')} is not allowed`);
  }
  if (code > 0x10ffff) throw new Error(`${what}: code point U+${code.toString(16)} is out of range`);
  if (code >= 0xd800 && code <= 0xdfff) throw new Error(`${what}: surrogate code point is not allowed`);
  // XML 1.0 Char excludes U+FFFE/U+FFFF (the production ends at #xFFFD in the BMP).
  if (code === 0xfffe || code === 0xffff) {
    throw new Error(`${what}: non-character U+${code.toString(16).toUpperCase()} is not allowed in XML 1.0`);
  }
}

function assertTextChars(text: string, what: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) as number;
    assertXmlChar(code, what);
    if (code > 0xffff) i += 1;
  }
}

function decodeEntities(raw: string, maxLength: number, what: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi < 0) throw new Error(`${what}: unterminated entity reference`);
    const name = raw.slice(amp + 1, semi);
    if (name === 'amp') out += '&';
    else if (name === 'lt') out += '<';
    else if (name === 'gt') out += '>';
    else if (name === 'quot') out += '"';
    else if (name === 'apos') out += "'";
    else if (name.startsWith('#x') || name.startsWith('#X')) {
      const digits = name.slice(2);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) throw new Error(`${what}: invalid hexadecimal character reference`);
      const code = Number.parseInt(digits, 16);
      assertXmlChar(code, what);
      out += String.fromCodePoint(code);
    } else if (name.startsWith('#')) {
      const digits = name.slice(1);
      if (!/^[0-9]{1,7}$/.test(digits)) throw new Error(`${what}: invalid character reference`);
      const code = Number.parseInt(digits, 10);
      assertXmlChar(code, what);
      out += String.fromCodePoint(code);
    } else {
      throw new Error(`${what}: entity &${name}; is not supported`);
    }
    if (out.length > maxLength) throw new Error(`${what}: expanded text exceeds ${maxLength} characters`);
    i = semi + 1;
  }
  if (out.length > maxLength) throw new Error(`${what}: text exceeds ${maxLength} characters`);
  return out;
}

class XmlParser {
  private index = 0;
  private elements = 0;
  private readonly limits: XmlLimits;

  constructor(private readonly text: string, limits: XmlLimits) {
    this.limits = limits;
  }

  parseDocument(): XmlElement {
    if (this.text.startsWith('\ufeff')) this.index = 1;
    if (this.text.startsWith('<?xml', this.index)) {
      const after = this.text[this.index + 5];
      if (after !== undefined && !isXmlWhitespace(after) && after !== '?') {
        throw new Error('xml: malformed XML declaration');
      }
      const end = this.text.indexOf('?>', this.index + 5);
      if (end < 0) throw new Error('xml: unterminated XML declaration');
      this.index = end + 2;
    }
    this.skipMisc();
    if (this.text[this.index] !== '<') throw new Error('xml: expected a root element');
    const root = this.parseElement(1);
    this.skipMisc();
    if (this.index !== this.text.length) {
      throw new Error(`xml: trailing content at ${this.index}`);
    }
    return root;
  }

  private skipWhitespace(): boolean {
    const start = this.index;
    while (this.index < this.text.length && isXmlWhitespace(this.text[this.index])) this.index += 1;
    return this.index > start;
  }

  private skipComment(): void {
    const end = this.text.indexOf('-->', this.index + 4);
    if (end < 0) throw new Error('xml: unterminated comment');
    this.index = end + 3;
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.text.startsWith('<!--', this.index)) {
        this.skipComment();
        continue;
      }
      if (this.text.startsWith('<!', this.index)) {
        throw new Error('xml: DOCTYPE and CDATA sections are not supported');
      }
      if (this.text.startsWith('<?', this.index)) {
        throw new Error('xml: processing instructions are not supported');
      }
      return;
    }
  }

  private readName(what: string): string {
    const start = this.index;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      const c = ch.charCodeAt(0);
      const ok =
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x30 && c <= 0x39) ||
        c === 0x5f || c === 0x2d || c === 0x2e;
      if (!ok) break;
      this.index += 1;
    }
    const name = this.text.slice(start, this.index);
    assertXmlName(name, this.limits.maxNameLength, what);
    return name;
  }

  private readAttributeValue(what: string): string {
    const quote = this.text[this.index];
    if (quote !== '"' && quote !== "'") throw new Error(`${what}: attribute value must be quoted`);
    this.index += 1;
    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== quote) {
      if (this.text[this.index] === '<') throw new Error(`${what}: raw '<' in attribute value`);
      this.index += 1;
    }
    if (this.index >= this.text.length) throw new Error(`${what}: unterminated attribute value`);
    const raw = this.text.slice(start, this.index);
    this.index += 1;
    if (raw.length > this.limits.maxValueLength) {
      throw new Error(`${what}: attribute value exceeds ${this.limits.maxValueLength} characters`);
    }
    const value = decodeEntities(raw, this.limits.maxValueLength, what);
    assertTextChars(value, what);
    return value;
  }

  private parseElement(depth: number): XmlElement {
    if (depth > this.limits.maxDepth) {
      throw new Error(`xml: nesting depth exceeds ${this.limits.maxDepth}`);
    }
    this.elements += 1;
    if (this.elements > this.limits.maxElements) {
      throw new Error(`xml: element count exceeds ${this.limits.maxElements}`);
    }
    if (this.text[this.index] !== '<') throw new Error(`xml: expected '<' at ${this.index}`);
    this.index += 1;
    if (this.text[this.index] === '/') throw new Error(`xml: unexpected end tag at ${this.index}`);
    const name = this.readName('xml element');
    const attributes: XmlAttribute[] = [];
    let selfClosing = false;

    for (;;) {
      const hadWhitespace = this.skipWhitespace();
      if (this.text.startsWith('/>', this.index)) {
        this.index += 2;
        selfClosing = true;
        break;
      }
      if (this.text[this.index] === '>') {
        this.index += 1;
        break;
      }
      if (!hadWhitespace) throw new Error(`xml: expected whitespace before attribute in <${name}>`);
      const attrName = this.readName('xml attribute');
      this.skipWhitespace();
      if (this.text[this.index] !== '=') throw new Error(`xml: expected '=' after attribute ${attrName}`);
      this.index += 1;
      this.skipWhitespace();
      const value = this.readAttributeValue(`xml attribute ${attrName}`);
      if (attributes.some((a) => a.name === attrName)) {
        throw new Error(`xml: duplicate attribute ${attrName} on <${name}>`);
      }
      attributes.push({ name: attrName, value });
      if (attributes.length > this.limits.maxAttributes) {
        throw new Error(`xml: <${name}> has more than ${this.limits.maxAttributes} attributes`);
      }
    }

    if (selfClosing) return { name, attributes, children: [], text: '' };

    const children: XmlElement[] = [];
    let text = '';
    for (;;) {
      if (this.index >= this.text.length) throw new Error(`xml: unclosed element <${name}>`);
      if (this.text.startsWith('</', this.index)) {
        this.index += 2;
        const endName = this.readName('xml end tag');
        if (endName !== name) throw new Error(`xml: </${endName}> does not close <${name}>`);
        this.skipWhitespace();
        if (this.text[this.index] !== '>') throw new Error(`xml: malformed end tag </${endName}>`);
        this.index += 1;
        break;
      }
      if (this.text.startsWith('<!--', this.index)) {
        this.skipComment();
        continue;
      }
      if (this.text.startsWith('<!', this.index)) {
        throw new Error('xml: DOCTYPE and CDATA sections are not supported');
      }
      if (this.text.startsWith('<?', this.index)) {
        throw new Error('xml: processing instructions are not supported');
      }
      if (this.text[this.index] === '<') {
        children.push(this.parseElement(depth + 1));
        continue;
      }
      const start = this.index;
      while (this.index < this.text.length && this.text[this.index] !== '<') this.index += 1;
      const raw = this.text.slice(start, this.index);
      if (raw.length > this.limits.maxTextLength) {
        throw new Error(`xml: text in <${name}> exceeds ${this.limits.maxTextLength} characters`);
      }
      const decoded = decodeEntities(raw, this.limits.maxTextLength, `xml text in <${name}>`);
      assertTextChars(decoded, `xml text in <${name}>`);
      text += decoded;
      if (text.length > this.limits.maxTextLength) {
        throw new Error(`xml: text in <${name}> exceeds ${this.limits.maxTextLength} characters`);
      }
    }
    return { name, attributes, children, text };
  }
}

function resolveLimits(limits?: Partial<XmlLimits>): XmlLimits {
  return { ...DEFAULT_XML_LIMITS, ...limits };
}

/** Parse an XML document from UTF-8 bytes. Throws on any violation. */
export function parseXml(bytes: Uint8Array, limits?: Partial<XmlLimits>): XmlElement {
  const lim = resolveLimits(limits);
  if (bytes.length > lim.maxBytes) throw new Error(`xml: document is ${bytes.length} bytes (maximum ${lim.maxBytes})`);
  return parseXmlString(decodeUtf8(bytes, 'xml'), limits);
}

/** Parse an XML document already decoded to a string. */
export function parseXmlString(text: string, limits?: Partial<XmlLimits>): XmlElement {
  const lim = resolveLimits(limits);
  if (text.length > lim.maxBytes) throw new Error(`xml: document is ${text.length} characters (maximum ${lim.maxBytes})`);
  return new XmlParser(text, lim).parseDocument();
}

export function xmlAttribute(element: XmlElement, name: string): string | undefined {
  for (const attr of element.attributes) if (attr.name === name) return attr.value;
  return undefined;
}

export function xmlChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export interface XmlSerializeOptions {
  declaration?: boolean;
  indent?: string;
  newline?: string;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function serializeElement(element: XmlElement, depth: number, options: Required<XmlSerializeOptions>): string {
  assertXmlName(element.name, DEFAULT_XML_LIMITS.maxNameLength, 'xml serialize');
  let open = `<${element.name}`;
  for (const attr of element.attributes) {
    assertXmlName(attr.name, DEFAULT_XML_LIMITS.maxNameLength, 'xml serialize');
    assertTextChars(attr.value, 'xml serialize attribute');
    if (attr.value.length > DEFAULT_XML_LIMITS.maxValueLength) {
      throw new Error(`xml serialize: attribute ${attr.name} exceeds ${DEFAULT_XML_LIMITS.maxValueLength} characters`);
    }
    open += ` ${attr.name}="${escapeXmlAttribute(attr.value)}"`;
  }
  const pad = options.indent.repeat(depth);
  if (element.children.length > 0) {
    if (!isWhitespaceText(element.text)) throw new Error(`xml serialize: <${element.name}> has mixed text and children`);
    let out = `${pad}${open}>${options.newline}`;
    for (const child of element.children) out += serializeElement(child, depth + 1, options);
    out += `${pad}</${element.name}>${options.newline}`;
    return out;
  }
  if (element.text.length > 0) {
    assertTextChars(element.text, 'xml serialize text');
    if (element.text.length > DEFAULT_XML_LIMITS.maxTextLength) {
      throw new Error(`xml serialize: text in <${element.name}> exceeds ${DEFAULT_XML_LIMITS.maxTextLength} characters`);
    }
    return `${pad}${open}>${escapeXmlText(element.text)}</${element.name}>${options.newline}`;
  }
  return `${pad}${open}/>${options.newline}`;
}

/** Serialize an element tree as a UTF-8 XML document. */
export function serializeXml(root: XmlElement, options?: XmlSerializeOptions): Uint8Array {
  const opts: Required<XmlSerializeOptions> = {
    declaration: options?.declaration ?? true,
    indent: options?.indent ?? '  ',
    newline: options?.newline ?? '\r\n',
  };
  const header = opts.declaration ? `<?xml version="1.0" encoding="UTF-8"?>${opts.newline}` : '';
  return encodeUtf8(header + serializeElement(root, 0, opts));
}
