/** Node-only JSON persistence. A missing file is new; a damaged file is an error. */
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryBank } from './memory.mjs';

export async function loadBank(path) {
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new MemoryBank(); throw error; }
  try {
    const data = JSON.parse(contents);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['schemaVersion', 'memories'].includes(key)) || data.schemaVersion !== 1 || !Object.hasOwn(data, 'memories')) {
      throw new TypeError('Expected memory backup schemaVersion 1');
    }
    return new MemoryBank({ memories: data.memories });
  } catch (cause) {
    throw new Error(`Cannot load memory file ${String(path)}: ${cause.message}`, { cause });
  }
}

export async function saveBank(path, bank) {
  if (!(bank instanceof MemoryBank)) throw new TypeError('bank must be a MemoryBank');
  const snapshot = { schemaVersion: 1, memories: bank.scopes().flatMap(scope => bank.export(scope).memories) };
  const contents = JSON.stringify(snapshot, null, 2) + '\n';
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
