// Runs the whole admin app inside one Netlify Function.
//
// The first time the function runs, it starts the Express app on a private
// port inside the function (127.0.0.1, which nothing outside can reach). Each
// visitor request Netlify hands us is passed to that port, and the app's reply
// is handed back to Netlify. Files in public/ (CSS, JavaScript, the officer
// timesheet page) never get here: Netlify serves them straight from its CDN.
import http from 'node:http';

// Netlify decides which libraries to package by reading this file's `import`
// lines. The app's own files load libraries with `require`, which it doesn't
// follow, so every library the app uses is listed here as well.
// (tests/netlify-function.test.js checks this list against package.json.)
import '@netlify/blobs';
import '@netlify/database';
import 'ejs';
import 'express';
import 'express-session';
import 'helmet';
import 'multer';
import 'pdf-lib';
import 'qrcode-svg';
import 'web-push';
import app from '../../src/app.js';

// Requests reach the app from 127.0.0.1, with the visitor's real address
// passed along in X-Forwarded-For, so the app should trust that header.
app.set('trust proxy', 'loopback');

// Headers that describe one particular connection, not the request or reply itself.
const CONNECTION_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

let appPort = null;
function startApp() {
  appPort ??= new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.unref(); // don't keep Node running just for this server (matters in tests)
  });
  return appPort;
}

function passToApp(port, { method, path, headers }, body) {
  return new Promise((resolve, reject) => {
    // agent: false = a fresh connection each time, so a connection never goes
    // stale while Netlify pauses the function between visits.
    const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (reply) => {
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, rawHeaders: reply.rawHeaders, body: Buffer.concat(chunks) }));
      reply.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) {
    if (!CONNECTION_HEADERS.has(name)) headers[name] = value;
  }
  // Tell the app who the visitor is and that they used https.
  if (context?.ip) headers['x-forwarded-for'] = context.ip;
  headers['x-forwarded-proto'] = 'https';
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  if (body) headers['content-length'] = String(body.length);

  const reply = await passToApp(await startApp(), { method: request.method, path: url.pathname + url.search, headers }, body);

  const replyHeaders = new Headers();
  for (let i = 0; i < reply.rawHeaders.length; i += 2) {
    const name = reply.rawHeaders[i].toLowerCase();
    if (!CONNECTION_HEADERS.has(name)) replyHeaders.append(name, reply.rawHeaders[i + 1]);
  }
  const noBody = request.method === 'HEAD' || [204, 304].includes(reply.status);
  return new Response(noBody ? null : reply.body, { status: reply.status, headers: replyHeaders });
};

// Handle every address, except ones that match a file in public/.
export const config = { path: '/*', preferStatic: true };
