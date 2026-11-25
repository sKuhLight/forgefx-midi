/**
 * Strict XML reader/writer tests: the documented element/attribute subset,
 * bounded parsing, no entity expansion, and deterministic serialization.
 */
import {
  isWhitespaceText,
  parseXml,
  parseXmlString,
  serializeXml,
  xmlAttribute,
  xmlChildren,
  type XmlElement,
} from '../../src/shared/xml.js';

export const XML_CASE_COUNT = 26;

function fail(msg: string): never {
  throw new Error(`[shared/xml] ${msg}`);
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) fail(`${label}: wrong error: ${message}`);
    return;
  }
  fail(`${label}: did not throw`);
}

function element(
  name: string,
  attributes: ReadonlyArray<readonly [string, string]>,
  children: XmlElement[] = [],
  body = '',
): XmlElement {
  return {
    name,
    attributes: attributes.map(([attrName, value]) => ({ name: attrName, value })),
    children,
    text: body,
  };
}

export function runXmlTests(): void {
  // 1 ── declaration, nested elements, self-closing child and attributes
  const root = parseXmlString(
    '<?xml version="1.0" encoding="UTF-8"?><Bundle-Map version="1"><Device deviceId="17"/></Bundle-Map>',
  );
  if (root.name !== 'Bundle-Map') fail('root name');
  if (xmlAttribute(root, 'version') !== '1') fail('root attribute');
  if (xmlChildren(root, 'Device').length !== 1) fail('child lookup');
  if (xmlAttribute(xmlChildren(root, 'Device')[0], 'deviceId') !== '17') fail('child attribute');

  // 2 ── serialize → parse round-trip
  const tree = element('r', [['a', 'x']], [element('c', [['b', 'y']], [], 'text')]);
  const encoded = serializeXml(tree);
  const reparsed = parseXml(encoded);
  if (reparsed.name !== 'r' || xmlAttribute(reparsed, 'a') !== 'x') fail('round-trip root');
  if (reparsed.children[0].text !== 'text') fail('round-trip text');
  if (xmlAttribute(reparsed.children[0], 'b') !== 'y') fail('round-trip child attribute');

  // 3 ── predefined and numeric entities decode
  const entities = parseXmlString(
    '<r a="&amp;&lt;&gt;&quot;&apos;&#65;&#x42;">&amp;&#67;</r>',
  );
  if (xmlAttribute(entities, 'a') !== '&<>"\'AB') fail(`entity attribute ${xmlAttribute(entities, 'a')}`);
  if (entities.text !== '&C') fail(`entity text ${entities.text}`);

  // 4 ── serializer escapes text and attribute values
  const escaped = serializeXml(element('r', [['a', '&<>"\'']], [], '&<>'));
  const escapedText = new TextDecoder().decode(escaped);
  if (!escapedText.includes('a="&amp;&lt;&gt;&quot;&apos;"')) fail('attribute escaping');
  if (!escapedText.includes('>&amp;&lt;&gt;</r>')) fail('text escaping');

  // 5 ── UTF-8 BOM is accepted
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text('<r/>')]);
  if (parseXml(bom).name !== 'r') fail('BOM');

  // 6 ── comments are skipped
  const commented = parseXmlString('<r><!-- ignore --><c/></r>');
  if (commented.children.length !== 1 || commented.children[0].name !== 'c') fail('comment');

  // 7 ── DOCTYPE is rejected (no entity expansion path)
  expectThrow(
    () => parseXmlString('<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>'),
    /DOCTYPE/,
    'DOCTYPE',
  );

  // 8 ── unknown entities are rejected
  expectThrow(() => parseXmlString('<r>&foo;</r>'), /entity &foo;/, 'unknown entity');

  // 9 ── numeric character references are range-checked
  expectThrow(() => parseXmlString('<r>&#0;</r>'), /NUL/, 'NUL reference');
  expectThrow(() => parseXmlString('<r>&#xD800;</r>'), /surrogate/, 'surrogate reference');
  expectThrow(() => parseXmlString('<r>&#x110000;</r>'), /out of range/, 'out-of-range reference');

  // 10 ── unterminated element
  expectThrow(() => parseXmlString('<r><c></r>'), /does not close|unclosed/, 'unclosed element');

  // 11 ── mismatched end tag
  expectThrow(() => parseXmlString('<r><c></d></r>'), /does not close/, 'mismatched end tag');

  // 12 ── duplicate attribute
  expectThrow(() => parseXmlString('<r a="1" a="2"/>'), /duplicate attribute/, 'duplicate attribute');

  // 13 ── raw '<' in an attribute value
  expectThrow(() => parseXmlString('<r a="<"/>'), /raw '<'/, 'raw less-than');

  // 14 ── text outside the root / trailing content
  expectThrow(() => parseXmlString('<r/>tail'), /trailing content/, 'trailing content');
  expectThrow(() => parseXmlString('text<r/>'), /root element/, 'leading text');

  // 15 ── depth limit is inclusive: maxDepth 3 allows exactly three levels
  if (parseXmlString('<a><b><c/></b></a>', { maxDepth: 3 }).name !== 'a') fail('maxDepth boundary');
  expectThrow(
    () => parseXmlString('<a><b><c><d/></c></b></a>', { maxDepth: 3 }),
    /nesting depth/,
    'maxDepth',
  );

  // 16 ── element-count limit
  expectThrow(
    () => parseXmlString('<a><b/><c/><d/></a>', { maxElements: 3 }),
    /element count/,
    'maxElements',
  );

  // 17 ── document byte limit
  expectThrow(() => parseXml(text('<r>' + 'x'.repeat(100) + '</r>'), { maxBytes: 20 }), /maximum 20/, 'maxBytes');

  // 18 ── attribute value limit
  expectThrow(
    () => parseXmlString('<r a="abcdef"/>', { maxValueLength: 3 }),
    /attribute value/,
    'maxValueLength',
  );

  // 19 ── processing instructions are rejected outside the declaration
  expectThrow(() => parseXmlString('<r><?pi x?></r>'), /processing instruction/, 'processing instruction');

  // 20 ── CDATA is rejected
  expectThrow(() => parseXmlString('<r><![CDATA[x]]></r>'), /CDATA/, 'CDATA');

  // 21 ── control characters in text
  expectThrow(() => parseXmlString('<r>\u0000</r>'), /NUL|control/, 'NUL text');

  // 22 ── helpers: whitespace and child filtering
  if (!isWhitespaceText(' \r\n\t')) fail('isWhitespaceText positive');
  if (isWhitespaceText(' x ')) fail('isWhitespaceText negative');
  if (xmlAttribute(root, 'missing') !== undefined) fail('missing attribute');

  // 23 ── mixed text and children cannot be serialized
  expectThrow(
    () => serializeXml(element('r', [], [element('c', [])], 'text')),
    /mixed text and children/,
    'mixed content',
  );

  // 24 ── invalid element names are rejected on both parse and serialize
  expectThrow(() => parseXmlString('<1a/>'), /XML name|first character/, 'invalid parse name');
  expectThrow(() => serializeXml(element('a:b', [])), /XML name/, 'invalid serialize name');

  // 25 ── the serializer never emits XML-1.0 non-characters U+FFFE/U+FFFF
  expectThrow(() => serializeXml(element('r', [], [], '\uffff')), /non-character/, 'serialize text U+FFFF');
  expectThrow(
    () => serializeXml(element('r', [['a', '\ufffe']])),
    /non-character/,
    'serialize attribute U+FFFE',
  );

  // 26 ── the parser rejects U+FFFE/U+FFFF in text, attributes and char refs
  expectThrow(() => parseXmlString('<r>\uffff</r>'), /non-character/, 'parse text U+FFFF');
  expectThrow(() => parseXmlString('<r a="\ufffe"/>'), /non-character/, 'parse attribute U+FFFE');
  expectThrow(() => parseXmlString('<r>&#xFFFF;</r>'), /non-character/, 'parse numeric U+FFFF');
  expectThrow(() => parseXmlString('<r a="&#xFFFE;"/>'), /non-character/, 'parse numeric U+FFFE');
}
