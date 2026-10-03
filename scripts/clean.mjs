#!/usr/bin/env node
/**
 * Removes build output and coverage artifacts from every workspace.
 * Kept dependency-free so `npm run clean` works before `npm install`.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = ['dist', 'coverage', '.tsbuildinfo'];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const packageDirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join('packages', entry.name));

for (const dir of [...packageDirs, '.']) {
  for (const target of targets) {
    const path = join(root, dir, target);
    if (await exists(path)) {
      await rm(path, { recursive: true, force: true });
      console.log(`removed ${dir}/${target}`);
    }
  }
}
