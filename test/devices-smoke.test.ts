// Device-descriptor layer smoke test.
//
// Imports every descriptor entry from the BUILT package (dist/), so it
// also proves the compiled subpath entries (`forgefx-midi/devices/*`)
// resolve without loading any native binding (node-midi / serialport
// both stay lazy). Requires `npm run build` to have run first.
//
// Asserts what each descriptor actually exposes:
//   - gen1 is a readOne-style single-read surface: reader.getParam +
//     reader.getParams (batch wrapper) and writer.setParam/setParams,
//     but NO reader.getPreset.
//   - gen2 / gen3 (Axe-Fx III, FM3, FM9, VP4) / am4 readers expose
//     getPreset + getParams; writers expose setParams.

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertFn(obj: Record<string, unknown>, key: string, label: string): void {
  assert(typeof obj[key] === 'function', `${label}.${key} is not a function`);
}

interface DescriptorLike {
  id: string;
  display_name: string;
  reader: Record<string, unknown>;
  writer: Record<string, unknown>;
}

function assertDescriptorShape(
  d: DescriptorLike | undefined,
  name: string,
  opts: { hasGetPreset: boolean },
): void {
  assert(d !== undefined && d !== null, `${name} export missing`);
  const desc = d as DescriptorLike;
  assert(typeof desc.id === 'string' && desc.id.length > 0, `${name}.id missing`);
  assert(
    typeof desc.reader === 'object' && desc.reader !== null,
    `${name}.reader object missing`,
  );
  assert(
    typeof desc.writer === 'object' && desc.writer !== null,
    `${name}.writer object missing`,
  );
  assertFn(desc.reader, 'getParam', `${name}.reader`);
  assertFn(desc.reader, 'getParams', `${name}.reader`);
  assertFn(desc.writer, 'setParam', `${name}.writer`);
  assertFn(desc.writer, 'setParams', `${name}.writer`);
  if (opts.hasGetPreset) {
    assertFn(desc.reader, 'getPreset', `${name}.reader`);
  } else {
    assert(
      !('getPreset' in desc.reader),
      `${name}.reader unexpectedly grew getPreset — update this smoke test`,
    );
  }
}

export const DEVICES_SMOKE_CASE_COUNT = 7;

export async function runDevicesSmokeTests(): Promise<void> {
  const gen1 = await import('../dist/devices/gen1/index.js');
  const gen2 = await import('../dist/devices/gen2/index.js');
  const gen3 = await import('../dist/devices/gen3/index.js');
  const am4 = await import('../dist/devices/am4/index.js');

  // gen1: single-read surface only (readOne-style getParam/getParams), no getPreset.
  assertDescriptorShape(gen1.AXEFXGEN1_DESCRIPTOR, 'AXEFXGEN1_DESCRIPTOR', { hasGetPreset: false });

  assertDescriptorShape(gen2.AXEFX2_DESCRIPTOR, 'AXEFX2_DESCRIPTOR', { hasGetPreset: true });

  assertDescriptorShape(gen3.AXEFX3_DESCRIPTOR, 'AXEFX3_DESCRIPTOR', { hasGetPreset: true });
  assertDescriptorShape(gen3.FM3_DESCRIPTOR, 'FM3_DESCRIPTOR', { hasGetPreset: true });
  assertDescriptorShape(gen3.FM9_DESCRIPTOR, 'FM9_DESCRIPTOR', { hasGetPreset: true });
  assertDescriptorShape(gen3.VP4_DESCRIPTOR, 'VP4_DESCRIPTOR', { hasGetPreset: true });

  assertDescriptorShape(am4.AM4_DESCRIPTOR, 'AM4_DESCRIPTOR', { hasGetPreset: true });

  // VP4 stays writes-gated: automatic save during navigation is off.
  const vp4 = gen3.VP4_DESCRIPTOR as DescriptorLike & {
    capabilities: { supports_save: boolean };
  };
  assert(
    vp4.capabilities.supports_save === false,
    'VP4_DESCRIPTOR.capabilities.supports_save must stay false (writes-gated behavior)',
  );
}
