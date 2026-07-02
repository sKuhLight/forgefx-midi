// Minimal ambient declarations for the `serialport` package.
//
// `serialport` is NOT a dependency of this package — it is loaded lazily
// via `await import('serialport')` inside `src/core/midi/serialTransport.ts`
// only, so environments without the native binding stay healthy until a
// serial connect is actually attempted. This declaration covers exactly the
// surface serialTransport.ts touches (static `list()` + the constructor);
// the opened port itself is typed via serialTransport's own structural
// `SerialPortLike` interface.
declare module 'serialport' {
  interface SerialPortListEntry {
    path: string;
    manufacturer?: string;
    vendorId?: string;
    productId?: string;
    pnpId?: string;
    friendlyName?: string;
  }

  class SerialPort {
    constructor(options: { path: string; baudRate?: number; autoOpen?: boolean });
    static list(): Promise<SerialPortListEntry[]>;
  }

  export { SerialPort };
}
