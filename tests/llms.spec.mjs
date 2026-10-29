import fs from 'node:fs/promises';
import { test, expect, XRHandle } from '../src/index.mjs';

// llms.txt is what coding agents read; its API list must match the code.
const INTERNAL = new Set(['constructor', 'missingRuntime', 'evaluate', 'input', 'targetRayForGrip']);

test('llms.txt lists exactly the public XRHandle methods', async () => {
  const text = await fs.readFile(new URL('../llms.txt', import.meta.url), 'utf8');
  const api = text.slice(text.indexOf('## API'), text.indexOf('\n## ', text.indexOf('## API') + 1));
  const listed = new Set([...api.matchAll(/`([a-zA-Z]+)\(/g)].map(m => m[1]));
  listed.delete('aimQuaternion');
  listed.delete('use');
  const methods = Object.getOwnPropertyNames(XRHandle.prototype).filter(name => !INTERNAL.has(name));
  expect([...listed].sort()).toEqual(methods.sort());
});

test('llms.txt is shipped and exported', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.files).toContain('llms.txt');
  expect(pkg.exports['./llms.txt']).toBe('./llms.txt');
});
