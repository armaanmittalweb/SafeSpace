// The slice of the Web Bluetooth API that SafeSpace uses. TypeScript's DOM lib does not
// ship these types (the API is Chromium-only), so they are declared here, minimally.

export interface BtCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly value: DataView | null;
  readonly properties?: { notify?: boolean; indicate?: boolean; read?: boolean; write?: boolean };
  startNotifications(): Promise<BtCharacteristic>;
  stopNotifications(): Promise<BtCharacteristic>;
  readValue(): Promise<DataView>;
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
}
export interface BtService {
  readonly uuid: string;
  getCharacteristic(uuid: string | number): Promise<BtCharacteristic>;
}
export interface BtServer {
  readonly connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<BtService>;
}
export interface BtDevice extends EventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: BtServer;
}
export interface BtRequestOptions {
  filters?: ({ services?: (string | number)[]; namePrefix?: string; name?: string })[];
  optionalServices?: (string | number)[];
  acceptAllDevices?: boolean;
}
export interface BtApi {
  requestDevice(opts: BtRequestOptions): Promise<BtDevice>;
  getAvailability?(): Promise<boolean>;
}

export function bluetooth(): BtApi | null {
  const n = (globalThis as { navigator?: { bluetooth?: BtApi } }).navigator;
  return n?.bluetooth ?? null;
}
