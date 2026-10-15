import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdScanner, parseReply } from '../src/services/scanner.js';

let server: net.Server | undefined;
afterEach(() => server?.close());

/** Minimal clamd INSTREAM implementation: flags content containing "EICAR". */
function fakeClamd(behaviour: 'normal' | 'garbage' | 'silent' = 'normal'): Promise<number> {
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let headerSeen = false;
    const data: Buffer[] = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerSeen) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        expect(buf.subarray(0, end).toString()).toBe('zINSTREAM');
        buf = buf.subarray(end + 1);
        headerSeen = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          if (behaviour === 'silent') return;
          const content = Buffer.concat(data).toString('latin1');
          const reply = behaviour === 'garbage' ? 'WAT' : content.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK';
          sock.end(`${reply}\0`);
          return;
        }
        if (buf.length < 4 + len) return;
        data.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port)));
}

describe('ClamdScanner', () => {
  it('reports clean content, including multi-chunk streams', async () => {
    const port = await fakeClamd();
    const r = await new ClamdScanner('127.0.0.1', port, 2000).scan(Buffer.alloc(200 * 1024, 1));
    expect(r).toEqual({ status: 'clean' });
  });

  it('reports infected content with its signature', async () => {
    const port = await fakeClamd();
    const r = await new ClamdScanner('127.0.0.1', port, 2000).scan(Buffer.from('xxEICARxx'));
    expect(r).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('treats unexpected replies, timeouts and connection errors as errors (never clean)', async () => {
    expect((await new ClamdScanner('127.0.0.1', await fakeClamd('garbage'), 2000).scan(Buffer.from('a'))).status).toBe('error');
    server?.close();
    expect((await new ClamdScanner('127.0.0.1', await fakeClamd('silent'), 300).scan(Buffer.from('a'))).status).toBe('error');
    server?.close();
    expect((await new ClamdScanner('127.0.0.1', 1, 1000).scan(Buffer.from('a'))).status).toBe('error');
  });

  it('parses replies strictly', () => {
    expect(parseReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseReply('stream: OK but not really').status).toBe('error');
  });
});
