// Serves the probe page and appends posted results to a JSONL file.
// node scripts/device-fov/server.mjs <results.jsonl>   PORT and FOV_PROBE_TOKEN are optional.
// A random path token keeps a public tunnel URL from being guessed.
import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const output = process.argv[2];
if (!output) throw new Error('usage: server.mjs <results.jsonl>');
const token = process.env.FOV_PROBE_TOKEN ?? randomBytes(12).toString('hex');
const page = await readFile(new URL('./index.html', import.meta.url));
const MAX_BODY = 256 * 1024;

const server = createServer((request, response) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    response.writeHead(code, { 'content-type': type });
    response.end(body);
  };
  const { pathname } = new URL(request.url, 'http://probe');
  if (request.method === 'GET' && pathname === `/${token}/`) return send(200, page, 'text/html; charset=utf-8');
  if (request.method !== 'POST' || pathname !== `/${token}/result`) return send(404, 'not found');
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { send(413, 'too large'); request.destroy(); } else chunks.push(chunk);
  });
  request.on('end', async () => {
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!['quest3', 'quest3s', 'emulator'].includes(result.device) || !Array.isArray(result.views)) throw new Error('unexpected shape');
      await appendFile(output, `${JSON.stringify(result)}\n`);
      console.log(`recorded ${result.device}`);
      send(200, 'ok');
    } catch (error) {
      send(400, error.message);
    }
  });
});

server.listen(Number(process.env.PORT ?? 0), '0.0.0.0', () => {
  console.log(`listening port=${server.address().port} path=/${token}/ results=${output}`);
});
