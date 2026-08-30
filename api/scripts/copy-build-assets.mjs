import { copyFile, mkdir } from 'node:fs/promises';

const sourceDirectory = new URL('../src/signers/bytedance/', import.meta.url);
const targetDirectory = new URL('../dist/signers/bytedance/', import.meta.url);
await mkdir(targetDirectory, { recursive: true });
for (const name of ['a_bogus.js', 'x_bogus.js']) {
  await copyFile(new URL(name, sourceDirectory), new URL(name, targetDirectory));
}
