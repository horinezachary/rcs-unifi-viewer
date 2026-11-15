// QR codes for joining Wi-Fi, made with qrcode-generator (MIT, Kazuhiko Arase), vendored in
// vendor/qrcode.cjs because packages carry no node_modules.

import { createRequire } from 'node:module';

interface QrCode {
  addData(data: string, mode?: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
interface QrFactory {
  (typeNumber: number, level: 'L' | 'M' | 'Q' | 'H'): QrCode;
  stringToBytes: (s: string) => number[];
  stringToBytesFuncs: Record<string, (s: string) => number[]>;
}

const qrcode = createRequire(import.meta.url)('../vendor/qrcode.cjs') as QrFactory;
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']!;

/** The code's modules, one string of 0s and 1s per row. */
export function qrRows(text: string): string[] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}
