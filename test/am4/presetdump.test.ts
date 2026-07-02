/**
 * AM4 preset-dump frame codec — framing, checksum, slicing, round-trip.
 *
 * Frames here are synthetic (built by the serializer itself), so the suite
 * asserts the structural invariants of the hardware-verified format — message
 * lengths, envelope, checksum, the frame-offset-0x21 name field, bank
 * addressing — without shipping any factory preset bytes.
 */
import {
  AM4_PRESET_FRAME_SIZE,
  AM4_PRESET_DUMP_HEADER_LEN,
  AM4_PRESET_DUMP_CHUNK_LEN,
  AM4_PRESET_DUMP_FOOTER_LEN,
  AM4_PRESET_DUMP_CHUNKS,
  AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN,
  AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN,
  AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN,
  AM4_DUMP_ACTIVE_BANK_SENTINEL,
  parseAm4PresetDump,
  parseAm4PresetBank,
  serializeAm4PresetDump,
  am4DumpLocation,
  encodeAm4PresetName,
  decodeAm4PresetNameFromFrame,
  AM4_PRESET_NAME_OFFSET,
  type Am4PresetDump,
} from '../../src/am4/index.js';

/** A structurally valid dump with the given addressing + deterministic payload fill. */
function syntheticDump(bank: number, sub: number, fill = 0x11): Uint8Array {
  const headerPayload = new Uint8Array(AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN);
  headerPayload[0] = bank;
  headerPayload[1] = sub;
  const chunkPayloads = Array.from({ length: AM4_PRESET_DUMP_CHUNKS }, (_, i) => {
    const p = new Uint8Array(AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN);
    p.fill((fill + i) & 0x7f);
    return p;
  });
  const footerPayload = new Uint8Array(AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN);
  footerPayload.set([0x71, 0x6f, 0x00]);
  const dump: Am4PresetDump = {
    raw: new Uint8Array(0),
    headerPayload,
    chunkPayloads,
    footerPayload,
  };
  return serializeAm4PresetDump(dump);
}

function assertThrows(what: string, fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`[am4/presetDump] ${what}: expected an error, none thrown`);
  }
}

export const AM4_PRESET_DUMP_CASE_COUNT = 12;

export function runAm4PresetDumpTests(): void {
  // 1. The message lengths compose to exactly one frame.
  const composed =
    AM4_PRESET_DUMP_HEADER_LEN +
    AM4_PRESET_DUMP_CHUNK_LEN * AM4_PRESET_DUMP_CHUNKS +
    AM4_PRESET_DUMP_FOOTER_LEN;
  if (composed !== AM4_PRESET_FRAME_SIZE) {
    throw new Error(
      `[am4/presetDump] message lengths compose to ${composed}, expected ${AM4_PRESET_FRAME_SIZE}`,
    );
  }

  // 2. Serialize → parse → serialize is byte-identical.
  const bytes = syntheticDump(0x02, 0x01); // C02
  if (bytes.length !== AM4_PRESET_FRAME_SIZE) {
    throw new Error(`[am4/presetDump] synthetic frame is ${bytes.length} bytes`);
  }
  const parsed = parseAm4PresetDump(bytes);
  const reserialized = serializeAm4PresetDump(parsed);
  if (Buffer.compare(Buffer.from(bytes), Buffer.from(reserialized)) !== 0) {
    throw new Error('[am4/presetDump] parse→serialize round-trip is not byte-identical');
  }

  // 3. Stored-location addressing decodes from the header payload.
  const loc = am4DumpLocation(parsed);
  if (loc.active || loc.index !== 9 || loc.code !== 'C02') {
    throw new Error(
      `[am4/presetDump] location: got active=${loc.active} index=${loc.index} code=${loc.code}, ` +
        `expected stored C02 (index 9)`,
    );
  }

  // 4. Active-buffer sentinel: bank 0x7F → no stored location.
  const active = am4DumpLocation(
    parseAm4PresetDump(syntheticDump(AM4_DUMP_ACTIVE_BANK_SENTINEL, 0x00)),
  );
  if (!active.active || active.index !== undefined || active.code !== undefined) {
    throw new Error('[am4/presetDump] active-buffer dump must carry no stored location');
  }

  // 5. The name field decodes from frame offset 0x21 (inside chunk 1's payload).
  const nameFrame = syntheticDump(0x00, 0x00, 0x00);
  nameFrame.set(encodeAm4PresetName('AM4 Gig Rig'), AM4_PRESET_NAME_OFFSET);
  // Re-parse fails now (chunk-1 checksum is stale), so patch via the codec instead:
  const nameDump = parseAm4PresetDump(syntheticDump(0x00, 0x00, 0x00));
  const chunk1 = Uint8Array.from(nameDump.chunkPayloads[0]!);
  chunk1.set(encodeAm4PresetName('AM4 Gig Rig'), AM4_PRESET_NAME_OFFSET - AM4_PRESET_DUMP_HEADER_LEN - 6);
  const namedBytes = serializeAm4PresetDump({
    ...nameDump,
    chunkPayloads: [chunk1, ...nameDump.chunkPayloads.slice(1)],
  });
  const decodedName = decodeAm4PresetNameFromFrame(namedBytes);
  if (decodedName !== 'AM4 Gig Rig') {
    throw new Error(`[am4/presetDump] name via frame offset 0x21: got "${decodedName}"`);
  }
  // ...and the checksum-stale variant must be rejected.
  assertThrows('stale chunk checksum after direct byte edit', () =>
    parseAm4PresetDump(nameFrame),
  );

  // 6. Bank slicing: 3 back-to-back frames → 3 dumps, in order.
  const bank = new Uint8Array(AM4_PRESET_FRAME_SIZE * 3);
  bank.set(syntheticDump(0x00, 0x00), 0); // A01
  bank.set(syntheticDump(0x00, 0x01), AM4_PRESET_FRAME_SIZE); // A02
  bank.set(syntheticDump(0x19, 0x03), AM4_PRESET_FRAME_SIZE * 2); // Z04
  const sliced = parseAm4PresetBank(bank);
  const codes = sliced.map((d) => am4DumpLocation(d).code);
  if (codes.join(',') !== 'A01,A02,Z04') {
    throw new Error(`[am4/presetDump] bank slice codes: ${codes.join(',')}`);
  }

  // 7. Rejections: truncated frame, non-multiple bank, empty bank.
  assertThrows('truncated frame', () => parseAm4PresetDump(bytes.subarray(0, 100)));
  assertThrows('bank length not a frame multiple', () =>
    parseAm4PresetBank(bank.subarray(0, AM4_PRESET_FRAME_SIZE + 5)),
  );
  assertThrows('empty bank', () => parseAm4PresetBank(new Uint8Array(0)));

  // 8. Rejections: corrupted checksum / wrong model byte.
  const corrupt = Uint8Array.from(bytes);
  corrupt[AM4_PRESET_DUMP_HEADER_LEN - 2] ^= 0x01; // header cs
  assertThrows('corrupted header checksum', () => parseAm4PresetDump(corrupt));
  const wrongModel = Uint8Array.from(bytes);
  wrongModel[4] = 0x14; // VP4 model byte in an AM4 frame
  assertThrows('wrong model byte', () => parseAm4PresetDump(wrongModel));
}
