import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { FileScanner, ScanResult } from './scanner.js';

export const MAX_PLAN_BYTES = 10 * 1024 * 1024;
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Detects the real type from the file signature; extension and declared type are not trusted. */
export function detectImageType(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface StoredFileMeta {
  id: string;
  mime: ImageMime;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error' | 'unscanned';
}

export class FileService {
  constructor(
    private readonly db: Db,
    private readonly scanner: FileScanner,
  ) {}

  /**
   * Stores the upload in quarantine (status "pending"), scans it, then records the verdict.
   * Infected content is discarded immediately; only "clean" (or "unscanned" in development) is ever served.
   */
  async storePlan(content: Buffer, mime: ImageMime, userId: string): Promise<{ meta: StoredFileMeta; scan: ScanResult }> {
    const sha = createHash('sha256').update(content).digest();
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO stored_file (kind, mime, size_bytes, sha256, content, scan_status, uploaded_by)
       VALUES ('floor_plan', $1, $2, $3, $4, 'pending', $5) RETURNING id`,
      [mime, content.length, sha, content, userId],
    );
    const id = rows[0]!.id;
    const scan = await this.scanner.scan(content);
    const detail = scan.status === 'infected' ? scan.signature : scan.status === 'error' ? scan.detail : null;
    await this.db.query(
      `UPDATE stored_file SET scan_status = $2, scan_detail = $3, scanned_at = now(),
              content = CASE WHEN $2 = 'infected' THEN NULL ELSE content END
        WHERE id = $1`,
      [id, scan.status, detail],
    );
    return { meta: { id, mime, sizeBytes: content.length, scanStatus: scan.status }, scan };
  }

  /** Returns content only for servable files. */
  async getServable(id: string): Promise<{ mime: ImageMime; content: Buffer; sha256: Buffer } | null> {
    const { rows } = await this.db.query<{ mime: ImageMime; content: Buffer; sha256: Buffer }>(
      `SELECT mime, content, sha256 FROM stored_file WHERE id = $1 AND scan_status IN ('clean','unscanned') AND content IS NOT NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM stored_file WHERE id = $1', [id]);
  }
}
