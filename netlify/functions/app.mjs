// Runs the whole admin app inside one Netlify Function.
//
// Netlify hands us each visitor's request. We pass it to the Express app as if
// it had arrived at an ordinary server, then hand the app's reply back to
// Netlify. Files in public/ (CSS, JavaScript, the officer timesheet page) never
// get here: Netlify serves them straight from its CDN.
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
import inject from 'light-my-request';
import app from '../../src/app.js';

// Requests reach the app from "inside" this function, with the visitor's real
// address passed along in X-Forwarded-For, so the app should trust that header.
app.set('trust proxy', 'loopback');

// Headers that only make sense on a direct connection, not on a reply we pass along.
const DROP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export default async (request, context) => {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  // Tell the app who the visitor is and that they used https.
  if (context?.ip) headers['x-forwarded-for'] = context.ip;
  headers['x-forwarded-proto'] = 'https';
  const hasBody = !['GET', 'HEAD'].includes(request.method);

  const reply = await inject(app, {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    payload: hasBody ? Buffer.from(await request.arrayBuffer()) : undefined,
    remoteAddress: '127.0.0.1',
  });

  const replyHeaders = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined || DROP_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) replyHeaders.append(name, String(item));
  }
  const noBody = request.method === 'HEAD' || [204, 304].includes(reply.statusCode);
  return new Response(noBody ? null : reply.rawPayload, { status: reply.statusCode, headers: replyHeaders });
};

// Handle every address, except ones that match a file in public/.
export const config = { path: '/*', preferStatic: true };
