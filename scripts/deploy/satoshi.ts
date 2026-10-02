/**
 * Deployment step (.github/workflows/deploy.yml): Satoshi, the face of StayPut's numbers and
 * titles (docs/design-tokens.md), is free for commercial use but it is not open source. Its
 * license, the ITF Free Font License 2.0 (in Fontshare's package; Inspect prints it), allows
 * self-hosting it with @font-face for our own application (§01), and forbids passing the files
 * on, through a repository among others, as well as subsetting or converting them (§02). This
 * repository is public, so the files are never committed: the deployment downloads Fontshare's
 * own package, checks it is the file reviewed, and serves the web font with the app, unchanged.
 * Self-hosted: the CSP allows no other origin, and no creator's browser has to ask a third
 * party for it. Without the file (local development, Fontshare down) the app falls back to
 * Geist, and the deployment says so.
 *
 *   tsx scripts/deploy/satoshi.ts apps/web/public            fetch, check, copy
 *   tsx scripts/deploy/satoshi.ts <dir> --report             also print the package's license
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Fontshare's download of the whole family (its « Download family » button). */
export const SATOSHI_URL = 'https://api.fontshare.com/v2/fonts/download/satoshi';

/** The variable web font: every weight from 300 to 900 in one file. */
export const SATOSHI_FILE = 'Satoshi-Variable.woff2';

/**
 * The SHA-256 of the file reviewed: Fontshare's package of 2 October 2026 (42,588 bytes, ITF Free
 * Font License 2.0 of 17 August 2026). A different file is left out (the app shows Geist) until
 * checked and pinned here; empty, any file would be taken, with a warning.
 */
export const SATOSHI_SHA256 = 'e739aff9b4d02c264341d6d4872edcda28e79373aeda936f659566a1cd3eb47f';

/** A file of a zip archive, read when asked. */
export interface ZipEntry {
  name: string;
  size: number;
  read: () => Buffer;
}

/**
 * The files of a zip archive (stored or deflated, what every zip tool writes): its central
 * directory at the end, then each file's local header for where its bytes start.
 */
export function readZip(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record: 22 bytes, then a comment of up to 64 KiB.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name,
      size,
      read: () => {
        if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`damaged zip entry ${name}`);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const bytes = zip.subarray(start, start + packed);
        if (method === 0) return Buffer.from(bytes);
        if (method === 8) return inflateRawSync(bytes);
        throw new Error(`${name}: compression ${method} is not supported`);
      },
    });
  }
  return entries;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The web font of the package (never the italic one), and its license texts. */
export function satoshiFiles(entries: readonly ZipEntry[]): {
  font: ZipEntry | undefined;
  licenses: ZipEntry[];
} {
  return {
    font: entries.find((entry) => path.posix.basename(entry.name) === SATOSHI_FILE),
    licenses: entries.filter(
      (entry) => /licen[cs]e|ffl|eula/i.test(entry.name) && /\.(txt|md)$/i.test(entry.name),
    ),
  };
}

export type SatoshiCheck = 'reviewed' | 'unpinned' | 'changed';

/** Whether the downloaded file is the one reviewed (`expected`: SATOSHI_SHA256). */
export function checkSatoshi(digest: string, expected: string): SatoshiCheck {
  if (!expected) return 'unpinned';
  return digest === expected ? 'reviewed' : 'changed';
}

async function main(): Promise<void> {
  const [publicDir, flag] = process.argv.slice(2);
  if (!publicDir) throw new Error('usage: tsx scripts/deploy/satoshi.ts <public dir> [--report]');
  const report = flag === '--report';
  const warn = (message: string) => console.warn(`::warning::Satoshi: ${message}`);

  let zip: Buffer;
  try {
    const response = await fetch(SATOSHI_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    warn(`Fontshare could not be reached (${String(error)}): the app shows Geist instead.`);
    return;
  }

  const entries = readZip(zip);
  const { font, licenses } = satoshiFiles(entries);
  if (report) {
    console.info(`Fontshare's package: ${zip.length} bytes, ${entries.length} files`);
    for (const entry of entries) console.info(`  ${entry.name} (${entry.size} bytes)`);
    for (const license of licenses) {
      console.info(`\n----- ${license.name} -----\n${license.read().toString('utf8')}`);
    }
  }
  if (!font) {
    warn(`no ${SATOSHI_FILE} in Fontshare's package: the app shows Geist instead.`);
    return;
  }

  const bytes = font.read();
  const digest = sha256(bytes);
  const check = checkSatoshi(digest, SATOSHI_SHA256);
  console.info(`${font.name}: ${bytes.length} bytes, sha256 ${digest} (${check})`);
  if (check === 'changed') {
    warn(`Fontshare changed ${SATOSHI_FILE} (sha256 ${digest}): left out until reviewed.`);
    return;
  }
  if (check === 'unpinned') warn(`no reviewed fingerprint yet: taking sha256 ${digest}.`);
  const dir = path.join(publicDir, 'fonts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SATOSHI_FILE), bytes);
  console.info(`Satoshi: ${path.join(dir, SATOSHI_FILE)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
