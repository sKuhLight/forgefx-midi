/**
 * AM4 / VP4 read-only definition walk and special-table reads.
 *
 * The driver walks `func 0x01 / action 0x0D` pseudo-registers — `0x07DD` (block descriptor, the
 * device-supplied parameter count), `0x07DC` (40-byte definition record) and `0x07EB` (one label,
 * text at payload `+0x08`) — plus the `action 0x12` name reads. Every frame goes through
 * `buildAm4ReadFrame`, which refuses any action outside `{0x0D, 0x12}`.
 *
 * These cases run synthetic frames through the real codec: exact module export surfaces (so no
 * write builder can appear on this path), the documented cab-name frame, the record layouts, the
 * label gate, and an end-to-end walk over a fake transport that records every frame.
 */
import * as definitionWalk from '../../src/am4/definitionWalk.js';
import * as readFrame from '../../src/am4/readFrame.js';
import * as am4Special from '../../src/am4/specialTables.js';
import {
  AM4_LABEL_FLAG,
  AM4_LABEL_TYPECODE_CLASSES,
  AM4_PARAM_COUNT_PID_HIGH,
  AM4_PARAM_DEFINITION_PID_HIGH,
  AM4_PARAM_LABEL_PID_HIGH,
  am4DefinitionWalk,
  buildReadBlockDescriptor,
  buildReadParamDefinition,
  buildReadParamLabel,
  parseBlockDescriptor,
  parseParamDefinition,
  parseParamLabel,
} from '../../src/am4/definitionWalk.js';
import {
  AM4_READ_ACTION_LONG,
  AM4_READ_ACTION_NAME,
  AM4_READ_ACTIONS,
  AM4_READ_MODEL_AM4,
  buildAm4ReadFrame,
  parseAm4ReadFrame,
  VP4_READ_MODEL_VP4,
} from '../../src/am4/readFrame.js';
import type { Am4ReadTransport } from '../../src/am4/readFrame.js';
import {
  AM4_CAB_NAME_PID_HIGH,
  AM4_CAB_NAME_PID_LOW,
  AM4_CAB_SCRATCHPAD_INDICES,
  am4CabBankTable,
  buildReadAm4CabName,
  parseAm4CabNameReply,
  readAm4CabNames,
  readAm4PresetNames,
} from '../../src/am4/specialTables.js';
import { packValueChunked } from '../../src/shared/packValue.js';

export const AM4_DEFINITION_WALK_CASE_COUNT = 12;

const noSleep = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Synthetic AM4 frames
// ---------------------------------------------------------------------------

/** An AM4 reply/request frame carrying `payload` under the given register fields. */
function am4Frame(model: number, pidLow: number, pidHigh: number, action: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from(buildAm4ReadFrame(model, pidLow, pidHigh, action, payload));
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

/** A 40-byte definition payload (see the module comment for the field map). */
function definitionPayload(spec: { tc: number; min: number; max: number; def: number; step: number; hasStrings?: boolean; flags?: number }): Uint8Array {
  const p = new Uint8Array(40);
  const dv = new DataView(p.buffer);
  dv.setUint16(4, Math.floor(spec.tc / 16), true);
  dv.setUint16(6, spec.tc & 0x0f, true);
  dv.setFloat32(0x0c, spec.min, true);
  dv.setFloat32(0x10, spec.max, true);
  dv.setFloat32(0x18, spec.def, true);
  dv.setFloat32(0x1c, spec.step, true);
  dv.setUint32(0x20, spec.hasStrings ? 1 : 0, true);
  dv.setUint16(0x24, spec.flags ?? 0, true);
  return p;
}

/** A 54-byte block descriptor: parameter count at +2. */
function descriptorPayload(count: number): Uint8Array {
  const p = new Uint8Array(54);
  new DataView(p.buffer).setUint16(2, count, true);
  return p;
}

/** A 40-byte label payload: 8 bytes of binary echo/value noise, then the 32-byte text field. */
function labelPayload(text: string): Uint8Array {
  const p = new Uint8Array(40);
  p.fill(0xff, 0, 8);
  for (let i = 0; i < text.length && i < 32; i++) p[8 + i] = text.charCodeAt(i) & 0x7f;
  return p;
}

/** A cab-name payload: 32-byte name field plus the optional attribute byte. */
function cabNamePayload(name: string, attribute?: number): Uint8Array {
  const len = attribute === undefined ? 32 : 33;
  const p = new Uint8Array(len);
  for (let i = 0; i < name.length && i < 32; i++) p[i] = name.charCodeAt(i) & 0xff;
  if (attribute !== undefined) p[32] = attribute;
  return p;
}

// ---------------------------------------------------------------------------
// Recording fake
// ---------------------------------------------------------------------------

interface Am4Query {
  model: number;
  pidLow: number;
  pidHigh: number;
  action: number;
  payload: Uint8Array;
}

interface Am4Fake extends Am4ReadTransport {
  readonly sent: Am4Query[];
  count(action: number, pidHigh?: number): number;
}

function am4Fake(respond: (q: Am4Query) => Uint8Array | null): Am4Fake {
  const sent: Am4Query[] = [];
  const f: Am4Fake = {
    sent,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q = parseAm4ReadFrame(query);
      if (!q) return Promise.reject(new Error('the test transport received a frame that is not an AM4 read'));
      sent.push({ model: q.model, pidLow: q.pidLow, pidHigh: q.pidHigh, action: q.action, payload: q.payload });
      return Promise.resolve(respond({ model: q.model, pidLow: q.pidLow, pidHigh: q.pidHigh, action: q.action, payload: q.payload }));
    },
    count: (action, pidHigh) => sent.filter((q) => q.action === action && (pidHigh === undefined || q.pidHigh === pidHigh)).length,
  };
  return f;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export async function runAm4DefinitionWalk(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[am4/definition-walk] ${msg}`);
  };

  // ---- Case 1: the module surfaces are exact and read-only --------------------------------
  {
    const expectedWalk = [
      'AM4_LABEL_FLAG',
      'AM4_LABEL_TYPECODE_CLASSES',
      'AM4_PARAM_COUNT_PID_HIGH',
      'AM4_PARAM_DEFINITION_PID_HIGH',
      'AM4_PARAM_LABEL_PID_HIGH',
      'am4DefinitionWalk',
      'buildReadBlockDescriptor',
      'buildReadParamDefinition',
      'buildReadParamLabel',
      'parseBlockDescriptor',
      'parseParamDefinition',
      'parseParamLabel',
    ];
    const expectedFrame = [
      'AM4_READ_ACTIONS',
      'AM4_READ_ACTION_LONG',
      'AM4_READ_ACTION_NAME',
      'AM4_READ_MODEL_AM4',
      'VP4_READ_MODEL_VP4',
      'buildAm4ReadFrame',
      'isAm4ReadModel',
      'parseAm4ReadFrame',
      'requestAm4Read',
    ];
    const expectedSpecial = [
      'AM4_CAB_NAME_PID_HIGH',
      'AM4_CAB_NAME_PID_LOW',
      'AM4_CAB_SCRATCHPAD_INDICES',
      'AM4_CAB_USER_SLOTS',
      'am4CabBankTable',
      'buildReadAm4CabName',
      'parseAm4CabNameReply',
      'readAm4CabNames',
      'readAm4PresetNames',
    ];
    const keysOf = (m: object): string[] => Object.keys(m).sort();
    if (keysOf(definitionWalk).join(',') !== expectedWalk.join(',')) fail(`definitionWalk exports: ${keysOf(definitionWalk).join(',')}`);
    if (keysOf(readFrame).join(',') !== expectedFrame.join(',')) fail(`readFrame exports: ${keysOf(readFrame).join(',')}`);
    if (keysOf(am4Special).join(',') !== expectedSpecial.join(',')) fail(`specialTables exports: ${keysOf(am4Special).join(',')}`);
    for (const name of [...keysOf(definitionWalk), ...keysOf(readFrame), ...keysOf(am4Special)]) {
      if (/^(set|write|save|rename|toggle|nudge|delete|erase|load|switch)/i.test(name)) fail(`a write-like export appeared: ${name}`);
      if (!/^(AM4_|VP4_|am4|buildRead|buildAm4Read|parse|readAm4|requestAm4Read|isAm4Read)/.test(name)) fail(`unexpected export on the read-only surface: ${name}`);
    }
  }
  console.log('  am4/definition-walk: the three modules expose only read/poll/parse functions and constants — the exact surface is pinned, nothing write-like can be added silently');

  // ---- Case 2: the frame builder refuses every write action --------------------------------
  {
    if (AM4_READ_ACTIONS.join(',') !== `${AM4_READ_ACTION_LONG},${AM4_READ_ACTION_NAME}`) fail(`read actions ${AM4_READ_ACTIONS.join(',')}`);
    for (const action of [0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000c, 0x001a, 0x001b, 0x0017, 0x007a, 0x007b, 0x007c]) {
      let threw = false;
      try {
        buildAm4ReadFrame(AM4_READ_MODEL_AM4, 0x3a, 0x0000, action, new Uint8Array(0));
      } catch {
        threw = true;
      }
      if (!threw) fail(`action 0x${action.toString(16)} was built by the read path`);
    }
    for (const model of [0x10, 0x11, 0x12, 0x15 + 1]) {
      let threw = false;
      try {
        buildAm4ReadFrame(model, 0x3a, 0x0000, AM4_READ_ACTION_LONG);
      } catch {
        threw = true;
      }
      if (!threw) fail(`model 0x${model.toString(16)} was accepted by the AM4/VP4 read path`);
    }
    // The long read and the name read are accepted for both models.
    for (const model of [AM4_READ_MODEL_AM4, VP4_READ_MODEL_VP4]) {
      if (parseAm4ReadFrame(am4Frame(model, 0x3a, 0x07dc, AM4_READ_ACTION_LONG, new Uint8Array(0)))?.model !== model) fail('a valid read frame was rejected');
    }
  }
  console.log('  am4/definition-walk: the frame builder accepts only action 0x0D / 0x12 and only models 0x14 / 0x15 — SET, SET_NORM, nudge, rename, save and transfer actions are refused');

  // ---- Case 3: the documented cab-name frame is byte-exact --------------------------------
  {
    const want = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0x3e, 0x00, 0x0c, 0x00, 0x12, 0x00, 0x00, 0x00, 0x04, 0x00, 0x0a, 0x40, 0x00, 0x00, 0x00, 0x7f, 0xf7];
    const got = buildReadAm4CabName(0x15);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) fail(`cab-name frame ${got.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    if (AM4_CAB_NAME_PID_LOW !== 0x3e || AM4_CAB_NAME_PID_HIGH !== 0x0c) fail('cab-name register constants changed');
  }
  console.log('  am4/definition-walk: the slot-0x15 cab-name request reproduces the documented 23-byte frame exactly');

  // ---- Case 4: the three definition builders target the right pseudo-registers -------------
  {
    const descriptor = buildReadBlockDescriptor(0x3a);
    const d = parseAm4ReadFrame(descriptor);
    if (!d || d.pidLow !== 0x3a || d.pidHigh !== AM4_PARAM_COUNT_PID_HIGH || d.action !== AM4_READ_ACTION_LONG || d.payload.length !== 0) fail(`descriptor query ${JSON.stringify(d && { ...d, payload: d.payload.length })}`);
    const definition = parseAm4ReadFrame(buildReadParamDefinition(0x3a, 10));
    if (!definition || definition.pidLow !== 0x3a || definition.pidHigh !== AM4_PARAM_DEFINITION_PID_HIGH || definition.payload.length !== 4) fail('definition query shape');
    if (new DataView(definition.payload.buffer, definition.payload.byteOffset, 4).getUint32(0, true) !== 10) fail('definition payload is not the u32 param index');
    const label = parseAm4ReadFrame(buildReadParamLabel(0x3a, 10, 0x1f4));
    if (!label || label.pidHigh !== AM4_PARAM_LABEL_PID_HIGH || label.payload.length !== 8) fail('label query shape');
    if (new DataView(label.payload.buffer, label.payload.byteOffset, 8).getUint32(0, true) !== 10 || new DataView(label.payload.buffer, label.payload.byteOffset, 8).getUint32(4, true) !== 0x1f4) fail('label payload is not {paramIndex, stringIndex}');
    // VP4 carries its own model byte on the same registers.
    const vp4 = parseAm4ReadFrame(buildReadParamDefinition(0x76, 3, VP4_READ_MODEL_VP4));
    if (!vp4 || vp4.model !== VP4_READ_MODEL_VP4 || vp4.pidHigh !== AM4_PARAM_DEFINITION_PID_HIGH) fail('VP4 definition query');
  }
  console.log('  am4/definition-walk: descriptor 0x07DD (no payload), definition 0x07DC (u32 index), label 0x07EB ({index, ordinal}) build for AM4 and VP4');

  // ---- Case 5: the block descriptor and its count -----------------------------------------
  {
    if (parseBlockDescriptor(descriptorPayload(0))?.paramCount !== 0) fail('a zero-count block must parse');
    if (parseBlockDescriptor(descriptorPayload(133))?.paramCount !== 133) fail('count at payload+2');
    if (parseBlockDescriptor(new Uint8Array(53)) !== null || parseBlockDescriptor(new Uint8Array(55)) !== null) fail('the descriptor must be exactly 54 bytes');
    const wide = descriptorPayload(0xffff);
    if (parseBlockDescriptor(wide)?.paramCount !== 0xffff) fail('the count is a u16');
  }
  console.log('  am4/definition-walk: block descriptor — exactly 54 bytes, parameter count = u16 at payload+0x02, zero means an empty block');

  // ---- Case 6: the definition record and the label gate -----------------------------------
  {
    const rec = parseParamDefinition(definitionPayload({ tc: 0x11, min: 0.5, max: 1.5, def: 100, step: 0.001, hasStrings: true, flags: 0x0004 }));
    if (!rec || rec.tc !== 0x11 || rec.min !== 0.5 || rec.max !== 1.5 || rec.def !== 100 || Math.abs(rec.step - 0.001) > 1e-6) fail(`definition fields ${JSON.stringify(rec)}`);
    if (!rec.hasStrings || rec.flags !== 0x0004 || !rec.hasLabelList) fail('a class-1 record with flags bit 2 is a label list');
    const class2 = parseParamDefinition(definitionPayload({ tc: 0x21, min: 0, max: 3, def: 0, step: 0, flags: 0x0004 }));
    if (!class2 || !class2.hasLabelList) fail('AM4 class 2 IS part of the AM4 label gate');
    // +0x24 alone must NOT be enough — the composed flags add bit 0x04 from the +0x20 word.
    const wireFlagOnly = parseParamDefinition(definitionPayload({ tc: 0x11, min: 0, max: 3, def: 0, step: 0, hasStrings: false, flags: 0x0010 }));
    if (!wireFlagOnly || wireFlagOnly.hasLabelList) fail('a flags word without bit 0x04 must stay float');
    // ... while the +0x20 "has a string list" word ALONE opens the gate.
    const stringsOnly = parseParamDefinition(definitionPayload({ tc: 0x11, min: 0, max: 3, def: 0, step: 0, hasStrings: true, flags: 0 }));
    if (!stringsOnly || !stringsOnly.hasLabelList || stringsOnly.flags !== 0x0004) fail(`+0x20-only gate ${JSON.stringify(stringsOnly)}`);
    // Neither word set: no label list, composed flags 0.
    const neither = parseParamDefinition(definitionPayload({ tc: 0x11, min: 0, max: 3, def: 0, step: 0, hasStrings: false, flags: 0 }));
    if (!neither || neither.hasLabelList || neither.flags !== 0) fail(`neither word ${JSON.stringify(neither)}`);
    if (AM4_LABEL_TYPECODE_CLASSES.size !== 5 || !AM4_LABEL_TYPECODE_CLASSES.has(2) || AM4_LABEL_FLAG !== 4) fail('the AM4 label gate constants changed');
    if (parseParamDefinition(definitionPayload({ tc: 0x11, min: 2, max: 1, def: 0, step: 0 })) !== null) fail('min > max must be rejected');
    if (parseParamDefinition(new Uint8Array(39)) !== null || parseParamDefinition(new Uint8Array(41)) !== null) fail('the definition payload must be exactly 40 bytes');
  }
  console.log('  am4/definition-walk: definition — tc = (hi << 4) | lo, min/max/def/step copied raw, class {1,2,10,11,12} + flags bit 0x04 opens a label list, min > max rejected');

  // ---- Case 7: the label text is payload[8..39], not the whole payload --------------------
  {
    const label = parseParamLabel(labelPayload('Auto In'));
    if (!label || label.text !== 'Auto In') fail(`label text ${JSON.stringify(label)}`);
    // Every one of the first eight bytes is 0xFF; a parser that took the whole payload would
    // produce spaces in front of the text.
    if (label.text.startsWith(' ')) fail('the label parser included the echo/value header');
    const nul = labelPayload('NUL\0tail');
    if (parseParamLabel(nul)?.text !== 'NUL') fail('a NUL must terminate the label');
    const control = labelPayload('');
    control[8] = 0x01;
    control[9] = 0x80;
    control[10] = 0x41;
    if (parseParamLabel(control)?.text !== '  A') fail('non-printable label bytes must read as spaces');
  }
  console.log('  am4/definition-walk: labels come from the 32-byte field at payload+0x08 (the 8-byte echo/value header is excluded), NUL-terminated, non-printables as spaces');

  // ---- Case 8: an end-to-end read-only walk ------------------------------------------------
  {
    const block = 0x3a;
    const defs: Record<number, Uint8Array> = {
      0: definitionPayload({ tc: 0x11, min: 0, max: 2, def: 1, step: 0, hasStrings: true, flags: 0 }),
      1: definitionPayload({ tc: 0x02, min: 0, max: 1, def: 10, step: 0.001 }),
      2: definitionPayload({ tc: 0x52, min: 0, max: 10, def: 1, step: 0 }),
    };
    const labels: Record<number, string> = { 0: 'Clean', 1: 'Crunch', 2: 'Lead' };
    const dev = am4Fake((q) => {
      if (q.model !== AM4_READ_MODEL_AM4 || q.action !== AM4_READ_ACTION_LONG) return null;
      if (q.pidHigh === AM4_PARAM_COUNT_PID_HIGH) return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, descriptorPayload(q.pidLow === block ? 3 : 0));
      if (q.pidLow !== block) return null;
      if (q.pidHigh === AM4_PARAM_DEFINITION_PID_HIGH) {
        const index = new DataView(q.payload.buffer, q.payload.byteOffset, 4).getUint32(0, true);
        return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, defs[index] ?? new Uint8Array(0));
      }
      if (q.pidHigh === AM4_PARAM_LABEL_PID_HIGH) {
        const dv = new DataView(q.payload.buffer, q.payload.byteOffset, 8);
        const index = dv.getUint32(0, true);
        const ordinal = dv.getUint32(4, true);
        return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, labelPayload(labels[ordinal] ?? `?${index}`));
      }
      return null;
    });
    const result = await am4DefinitionWalk(dev, { blocks: [block, 0x3b], sections: { [block]: 10, 0x3b: 10 }, sleep: noSleep });
    if (result.records.length !== 3 || result.blocksRead !== 2 || result.paramsRead !== 3) fail(`walk outcome ${JSON.stringify({ ...result, records: result.records.length })}`);
    if (result.labelLists !== 1 || result.labelsRead !== 3) fail(`label accounting ${JSON.stringify({ labelLists: result.labelLists, labelsRead: result.labelsRead })}`);
    const amp = result.records.filter((r) => r.section === 10);
    if (amp.length !== 3 || amp[0]!.kind !== 'enum' || amp[0]!.id !== 0 || amp[0]!.values.join(',') !== 'Clean,Crunch,Lead') fail(`param 0 ${JSON.stringify(amp[0])}`);
    if (amp[1]!.kind !== 'float' || amp[1]!.id !== 1 || amp[2]!.kind !== 'float' || amp[2]!.id !== 2) fail('params 1/2 must be floats');
    if (amp[0]!.kind === 'enum' && amp[0]!.count !== 3) fail('an enum record count must be max-min+1');
    if (result.queries !== 8) fail(`${result.queries} queries, want 8 (2 descriptors + 3 definitions + 3 labels)`);
    if (dev.sent.some((q) => q.action !== AM4_READ_ACTION_LONG)) fail('the definition walk sent a non-0x0D action');
    if (dev.count(AM4_READ_ACTION_LONG, AM4_PARAM_COUNT_PID_HIGH) !== 2 || dev.count(AM4_READ_ACTION_LONG, AM4_PARAM_DEFINITION_PID_HIGH) !== 3 || dev.count(AM4_READ_ACTION_LONG, AM4_PARAM_LABEL_PID_HIGH) !== 3) fail('the walk queried an unexpected register set');
    // Param 0's gate came from the +0x20 word alone (its +0x24 flags word is 0), and a fractional
    // max rounds the string count up: `int(max-min+0.5)+1` is 4 for 0..2.6, not 3.
    const fractional = am4Fake((q) => {
      if (q.action !== AM4_READ_ACTION_LONG) return null;
      if (q.pidHigh === AM4_PARAM_COUNT_PID_HIGH) return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, descriptorPayload(1));
      if (q.pidHigh === AM4_PARAM_DEFINITION_PID_HIGH) return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, definitionPayload({ tc: 0x11, min: 0, max: 2.6, def: 1, step: 0, hasStrings: true, flags: 0 }));
      if (q.pidHigh === AM4_PARAM_LABEL_PID_HIGH) {
        const ordinal = new DataView(q.payload.buffer, q.payload.byteOffset, 8).getUint32(4, true);
        return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, labelPayload(`R${ordinal}`));
      }
      return null;
    });
    const fr = await am4DefinitionWalk(fractional, { blocks: [block], sleep: noSleep });
    const frRec = fr.records[0];
    if (!frRec || frRec.kind !== 'enum' || frRec.values.join(',') !== 'R0,R1,R2,R3') fail(`fractional max: ${JSON.stringify(frRec)}`);
  }
  console.log('  am4/definition-walk: end-to-end walk — 2 descriptors, 3 definitions, 3 labels; the +0x20 word alone opens the gate; a fractional max rounds the label count up; every frame is action 0x0D');

  // ---- Case 9: lost and malformed replies are counted, never invented --------------------
  {
    const block = 0x3a;
    const dev = am4Fake((q) => {
      if (q.pidLow !== block) return null;
      if (q.pidHigh === AM4_PARAM_COUNT_PID_HIGH) return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, descriptorPayload(2));
      if (q.pidHigh === AM4_PARAM_DEFINITION_PID_HIGH) {
        const index = new DataView(q.payload.buffer, q.payload.byteOffset, 4).getUint32(0, true);
        if (index === 1) return null; // lost definition
        return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, definitionPayload({ tc: 0x11, min: 0, max: 2, def: 1, step: 0, flags: 0x0004 }));
      }
      if (q.pidHigh === AM4_PARAM_LABEL_PID_HIGH) {
        const ordinal = new DataView(q.payload.buffer, q.payload.byteOffset, 8).getUint32(4, true);
        return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, ordinal === 2 ? new Uint8Array(39) : labelPayload(`L${ordinal}`));
      }
      return null;
    });
    const result = await am4DefinitionWalk(dev, { blocks: [block], retries: 0, sleep: noSleep });
    if (result.paramsRead !== 1 || result.records.length !== 1) fail(`lost definition kept ${result.records.length} records / ${result.paramsRead} params`);
    if (result.lostReplies !== 1 || result.malformedReplies !== 1) fail(`loss accounting ${JSON.stringify({ lost: result.lostReplies, malformed: result.malformedReplies })}`);
    const rec = result.records[0];
    if (!rec || rec.kind !== 'enum' || rec.values.join(',') !== 'L0,L1') fail(`a cut-short label list must stay visible: ${JSON.stringify(rec)}`);
  }
  console.log('  am4/definition-walk: a lost definition is counted and skipped; a malformed label ends its list — the collected labels stay visible, nothing is fabricated');

  // ---- Case 10: cab names — the attribute byte and the open 32-byte form -----------------
  {
    const withAttr = parseAm4CabNameReply(cabNamePayload('G12h 57 md a', 1));
    if (!withAttr || withAttr.name !== 'G12h 57 md a' || withAttr.attribute !== 1) fail(`cab name ${JSON.stringify(withAttr)}`);
    const empty = parseAm4CabNameReply(cabNamePayload('<EMPTY>', 0xff));
    if (!empty || empty.name !== '<EMPTY>' || empty.attribute !== 255) fail(`empty cab ${JSON.stringify(empty)}`);
    for (const [raw, want] of [[0, 0], [1, 1], [2, 2], [3, 255], [0x7f, 255], [0x80, 255]] as const) {
      const p = parseAm4CabNameReply(cabNamePayload('X', raw));
      if (p?.attribute !== want) fail(`attribute ${raw} -> ${p?.attribute}, want ${want}`);
    }
    const shortForm = parseAm4CabNameReply(cabNamePayload('X'));
    if (!shortForm || shortForm.attribute !== undefined) fail('a 32-byte reply has no attribute (the 32-vs-33-byte form is open)');
    if (parseAm4CabNameReply(new Uint8Array(31)) !== null) fail('a short name payload must be rejected');
    if (AM4_CAB_SCRATCHPAD_INDICES.join(',') !== '256,257') fail('scratchpad indices changed');
    // The register's index space ends at 0x101 (User 0..255 + two scratchpads).
    if (buildReadAm4CabName(0x101).length !== 23) fail('the last valid cab-name slot must build a 23-byte frame');
    let threw = false;
    try {
      buildReadAm4CabName(0x102);
    } catch {
      threw = true;
    }
    if (!threw) fail('a slot above 0x101 must be refused');
  }
  console.log('  am4/definition-walk: cab names — 32-byte field + attribute (0/1/2, else 255); a 32-byte reply leaves the attribute unknown instead of inventing 255');

  // ---- Case 11: reading the AM4 cab bank -------------------------------------------------
  {
    const dev = am4Fake((q) => {
      if (q.model !== AM4_READ_MODEL_AM4 || q.action !== AM4_READ_ACTION_NAME || q.pidLow !== AM4_CAB_NAME_PID_LOW || q.pidHigh !== AM4_CAB_NAME_PID_HIGH) return null;
      const slot = new DataView(q.payload.buffer, q.payload.byteOffset, 4).getUint32(0, true);
      return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, cabNamePayload(slot === 0 ? 'IR one' : slot === 1 ? '<EMPTY>' : 'SP', slot === 0 ? 2 : 0xff));
    });
    const read = await readAm4CabNames(dev, [0, 1], { retries: 0, sleep: noSleep });
    if (read.entries.length !== 2 || read.entries[0]!.name !== 'IR one' || read.entries[0]!.attribute !== 2 || read.entries[1]!.name !== '<EMPTY>') fail(`cab read ${JSON.stringify(read.entries)}`);
    if (dev.sent.some((q) => q.action !== AM4_READ_ACTION_NAME)) fail('the cab reader sent a non-0x12 action');
    const table = am4CabBankTable(read.entries, 11, 0xfff0);
    if (!table || table.names.join(',') !== 'IR one,<EMPTY>' || table.wireIds.join(',') !== '2,255') fail(`cab table ${JSON.stringify(table)}`);
    // A missing attribute on any slot makes the bank unknown, not 255-by-default.
    const partial = am4CabBankTable([{ slot: 0, name: 'IR one', attribute: 2 }, { slot: 1, name: 'IR two' }], 11, 0xfff0);
    if (partial !== null) fail('a bank with an unknown attribute must not become a table');
    // The scratchpad read uses the same op at indices 0x100 / 0x101.
    const pads = await readAm4CabNames(dev, AM4_CAB_SCRATCHPAD_INDICES, { retries: 0, sleep: noSleep });
    if (pads.entries.length !== 2 || pads.entries[0]!.slot !== 0x100 || pads.entries[1]!.slot !== 0x101) fail('scratchpad read');
  }
  console.log('  am4/definition-walk: readAm4CabNames reads the User bank one slot at a time (action 0x12) and builds 0xFFF0 only when every attribute is known');

  // ---- Case 12: reading the AM4 preset-name table -----------------------------------------
  {
    const name32 = (name: string): Uint8Array => {
      const p = new Uint8Array(32);
      for (let i = 0; i < name.length && i < 32; i++) p[i] = name.charCodeAt(i) & 0x7f;
      return p;
    };
    if (packValueChunked(name32('')).length !== 37) fail('the 32-byte name field must pack to 37 wire bytes (4 x 8 + 5)');
    const dev = am4Fake((q) => {
      if (q.model !== AM4_READ_MODEL_AM4 || q.action !== AM4_READ_ACTION_NAME || q.pidLow !== 0x00ce || q.pidHigh !== 0x000b) return null;
      const location = new DataView(q.payload.buffer, q.payload.byteOffset, 4).getUint32(0, true);
      return am4Frame(q.model, q.pidLow, q.pidHigh, q.action, name32(location === 0 ? 'AM4 Gig Rig' : '<EMPTY>'));
    });
    const read = await readAm4PresetNames(dev, [0, 1], { retries: 0, sleep: noSleep });
    if (read.entries.length !== 2 || read.entries[0]!.location !== 0 || read.entries[0]!.name !== 'AM4 Gig Rig' || read.entries[1]!.name !== '<EMPTY>') fail(`preset read ${JSON.stringify(read.entries)}`);
    if (dev.count(AM4_READ_ACTION_NAME) !== 2) fail('the preset reader must issue one 0x12 read per location');
  }
  console.log('  am4/definition-walk: readAm4PresetNames — one action 0x12 read per location, the hardware-verified 55-byte name frame, "<EMPTY>" kept');
}
