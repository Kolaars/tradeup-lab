#!/usr/bin/env node
/** Tiny zero-dependency static server for local development. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const url = decodeURIComponent((request.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);

  if (!path.resolve(filePath).startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!path.extname(filePath)) filePath = path.join(filePath, 'index.html');

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>404</h1>');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`TradeUp Lab → http://localhost:${PORT}/`);
});
