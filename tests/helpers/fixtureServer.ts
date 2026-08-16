/**
 * Local fixture HTTP server bound to 127.0.0.1 for browser integration
 * and e2e tests. Serves the fixture HTML corpus, generated PNG images,
 * an eBay-shaped listing under /itm/<id>, and policy-test routes
 * (redirects, protected endpoints).
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Minimal valid PNG of the given solid color and size. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 3] = rgb[0];
      raw[rowStart + 2 + x * 3] = rgb[1];
      raw[rowStart + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface FixtureServer {
  server: Server;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const pngSmall = makePng(64, 64, [200, 30, 30]);
  const pngMedium = makePng(320, 200, [30, 120, 200]);
  const pngLarge = makePng(640, 400, [30, 200, 90]);

  const listingHtml = readFileSync(join(FIXTURES_DIR, 'ebay', 'active-listing.html'), 'utf8');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    const sendHtml = (html: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const sendPng = (png: Buffer): void => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
      res.end(png);
    };

    if (path.startsWith('/pages/')) {
      try {
        const file = path.replace('/pages/', '').replace(/[^A-Za-z0-9_.-]/g, '');
        sendHtml(readFileSync(join(FIXTURES_DIR, 'pages', file), 'utf8'));
      } catch {
        sendHtml('<h1>404</h1>', 404);
      }
      return;
    }
    if (path.startsWith('/ebay/')) {
      try {
        const file = path.replace('/ebay/', '').replace(/[^A-Za-z0-9_.-]/g, '');
        sendHtml(readFileSync(join(FIXTURES_DIR, 'ebay', file), 'utf8'));
      } catch {
        sendHtml('<h1>404</h1>', 404);
      }
      return;
    }
    // eBay-shaped listing page with a LOCAL gallery for e2e image tests.
    if (/^\/itm\/\d+$/.test(path)) {
      const localized = listingHtml
        .replaceAll('https://i.ebayimg.com/images/g/AAAAAAAAAA1/s-l500.jpg', '/img/gallery-1.png?size=500')
        .replaceAll('https://i.ebayimg.com/images/g/AAAAAAAAAA1/s-l64.jpg', '/img/gallery-1.png?size=64')
        .replaceAll('https://i.ebayimg.com/images/g/BBBBBBBBBB2/s-l500.jpg', '/img/gallery-2.png')
        .replaceAll('https://thumbs2.ebayimg.com/images/g/CCCCCCCCCC3/s-l300.jpg', '/img/gallery-3.png');
      sendHtml(localized);
      return;
    }
    if (path === '/img/gallery-1.png') {
      sendPng(url.searchParams.get('size') === '64' ? pngSmall : pngMedium);
      return;
    }
    if (path === '/img/gallery-2.png') {
      sendPng(pngMedium);
      return;
    }
    if (path === '/img/gallery-3.png') {
      sendPng(pngLarge);
      return;
    }
    if (path === '/redirect/hop') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    if (path === '/checkout/start' || path === '/placebid' || path === '/bestoffer' || path === '/cart/add') {
      sendHtml('<h1>TRANSACTION ENDPOINT REACHED (must never happen in tests)</h1>');
      return;
    }
    if (path === '/slow') {
      setTimeout(() => sendHtml('<h1>slow</h1>'), 5000);
      return;
    }
    sendHtml('<h1>fixture index</h1><a href="/pages/interact.html">interact</a>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
