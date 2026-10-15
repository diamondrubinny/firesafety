import net from 'node:net';

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; detail: string }
  | { status: 'unscanned' };

export interface FileScanner {
  scan(content: Buffer): Promise<ScanResult>;
}

/** Development/test only: config validation forbids it in production. */
export class NoopScanner implements FileScanner {
  async scan(): Promise<ScanResult> {
    return { status: 'unscanned' };
  }
}

/**
 * Minimal clamd client using the INSTREAM command (zero-terminated variant).
 * Protocol: "zINSTREAM\0", then chunks prefixed by a 4-byte big-endian length, then a zero-length chunk.
 * Reply: "stream: OK\0" or "stream: <signature> FOUND\0".
 */
export class ClamdScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  scan(content: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ status: 'error', detail: 'scanner timeout' }));
      socket.on('error', (err) => done({ status: 'error', detail: `scanner unavailable (${(err as NodeJS.ErrnoException).code ?? 'error'})` }));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => done(parseReply(Buffer.concat(chunks).toString('utf8'))));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < content.length; i += CHUNK) {
          const part = content.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // terminator
      });
    });
  }
}

export function parseReply(raw: string): ScanResult {
  const reply = raw.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(reply)) return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'infected', signature: found[1]!.slice(0, 200) };
  return { status: 'error', detail: `unexpected scanner reply: ${reply.slice(0, 100)}` };
}
