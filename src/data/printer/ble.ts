/**
 * 蓝牙打印机连接（Web Bluetooth，只支持 BLE；Android / Windows 的 Chrome、Edge 可用，iPad / iPhone 的 Safari 不行）。
 * - 第一次连接必须由员工点按钮触发（Chrome 规定），会弹出系统的设备选择框。
 * - 同一个页面里断线，写数据前自动重连，不用再点。页面重开后，浏览器支持 getDevices 时试着自动连回，不行就要再点一次。
 * - 便宜热敏机的 BLE 服务各家不同：列出常见的几个，找到第一个能写的通道就用。
 * - 分小包写，每包之间停一下，免得打印机缓冲区溢出打出乱码。包大小和停顿到货后按实机再调。
 */

export interface PrinterLink {
  id: string;
  name: string;
  connected(): boolean;
  /** preview 只给假打印机用，真打印机忽略。 */
  write(bytes: Uint8Array, preview?: string[]): Promise<void>;
  disconnect(): void;
  onDisconnect(cb: () => void): void;
}

export type LinkErrorCode = 'UNSUPPORTED' | 'CANCELLED' | 'NO_WRITABLE' | 'CONNECT_FAILED' | 'WRITE_FAILED';

export class PrinterLinkError extends Error {
  constructor(public code: LinkErrorCode, message?: string) {
    super(message ?? code);
  }
}

// ---- 最小的 Web Bluetooth 类型（TypeScript 自带的 DOM 类型里没有） ----

export interface BtCharacteristic {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
  writeValueWithResponse?(value: Uint8Array): Promise<void>;
  writeValue(value: Uint8Array): Promise<void>;
}
interface BtService {
  uuid: string;
  getCharacteristics(): Promise<BtCharacteristic[]>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<BtService[]>;
}
interface BtDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BtServer;
}
interface Bluetooth {
  requestDevice(options: { acceptAllDevices?: boolean; optionalServices?: string[] }): Promise<BtDevice>;
  getDevices?(): Promise<BtDevice[]>;
}

/** 常见热敏打印机的 BLE 服务（按常见程度排）。 */
export const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // 大多数国产热敏机（Xprinter、佳博等）
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4aa5-8fa9-9fafd205e455', // Microchip 透传
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '0000ae30-0000-1000-8000-00805f9b34fb',
];

const bluetooth = (): Bluetooth | null => (typeof navigator !== 'undefined' && 'bluetooth' in navigator ? (navigator as unknown as { bluetooth: Bluetooth }).bluetooth : null);

export function bluetoothSupported(): boolean {
  return bluetooth() !== null;
}

/** 写数据的包大小与停顿。20 字节在任何 BLE 连接上都放得下；到货后可按实机调大。 */
export const WRITE_TUNING = { chunk: 20, pauseMs: 8 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 分包写入。能「无回应写」就用它（快），每包之间停一下；否则用有回应的写（慢但稳）。 */
export async function writeChunked(ch: BtCharacteristic, bytes: Uint8Array, tuning = WRITE_TUNING): Promise<void> {
  const fast = ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === 'function';
  for (let i = 0; i < bytes.length; i += tuning.chunk) {
    const part = bytes.slice(i, i + tuning.chunk);
    if (fast) {
      await ch.writeValueWithoutResponse!(part);
      if (tuning.pauseMs > 0) await sleep(tuning.pauseMs);
    } else if (typeof ch.writeValueWithResponse === 'function') {
      await ch.writeValueWithResponse(part);
    } else {
      await ch.writeValue(part);
    }
  }
}

async function findWritable(server: BtServer): Promise<BtCharacteristic> {
  const services = await server.getPrimaryServices();
  const rank = (uuid: string) => {
    const i = PRINTER_SERVICES.indexOf(uuid.toLowerCase());
    return i < 0 ? PRINTER_SERVICES.length : i;
  };
  for (const svc of [...services].sort((a, b) => rank(a.uuid) - rank(b.uuid))) {
    for (const ch of await svc.getCharacteristics()) {
      if (ch.properties.writeWithoutResponse || ch.properties.write) return ch;
    }
  }
  throw new PrinterLinkError('NO_WRITABLE', '这台设备没有可写的打印通道，可能不是打印机或不支持 BLE');
}

async function openLink(device: BtDevice): Promise<PrinterLink> {
  const gatt = device.gatt;
  if (!gatt) throw new PrinterLinkError('CONNECT_FAILED');
  let ch: BtCharacteristic | null = null;
  let manualClose = false;
  const listeners: (() => void)[] = [];
  const ensure = async () => {
    if (gatt.connected && ch) return ch;
    try {
      const server = await gatt.connect();
      ch = await findWritable(server);
      return ch;
    } catch (e) {
      if (e instanceof PrinterLinkError) throw e;
      throw new PrinterLinkError('CONNECT_FAILED', e instanceof Error ? e.message : String(e));
    }
  };
  device.addEventListener('gattserverdisconnected', () => {
    ch = null;
    if (!manualClose) listeners.forEach((l) => l());
  });
  await ensure();
  return {
    id: device.id,
    name: device.name || '蓝牙打印机',
    connected: () => gatt.connected,
    async write(bytes) {
      manualClose = false;
      const c = await ensure();
      try {
        await writeChunked(c, bytes);
      } catch (e) {
        throw new PrinterLinkError('WRITE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },
    disconnect() {
      manualClose = true;
      ch = null;
      if (gatt.connected) gatt.disconnect();
    },
    onDisconnect(cb) {
      listeners.push(cb);
    },
  };
}

/** 弹出系统设备选择框（必须在点击里调用）。 */
export async function pickBlePrinter(): Promise<PrinterLink> {
  const bt = bluetooth();
  if (!bt) throw new PrinterLinkError('UNSUPPORTED');
  let device: BtDevice;
  try {
    device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES });
  } catch (e) {
    // 员工关掉选择框：NotFoundError。
    throw new PrinterLinkError('CANCELLED', e instanceof Error ? e.message : String(e));
  }
  return openLink(device);
}

/** 页面重开后试着连回上次的打印机（浏览器不支持或连不上就返回 null，要员工再点一次）。 */
export async function restoreBlePrinter(id: string): Promise<PrinterLink | null> {
  const bt = bluetooth();
  if (!bt?.getDevices) return null;
  try {
    const device = (await bt.getDevices()).find((d) => d.id === id);
    return device ? await openLink(device) : null;
  } catch {
    return null;
  }
}
