import { copyFile, mkdir } from 'node:fs/promises';

const bytedanceSource = new URL('../src/signers/bytedance/', import.meta.url);
const bytedanceTarget = new URL('../dist/signers/bytedance/', import.meta.url);
await mkdir(bytedanceTarget, { recursive: true });
for (const name of ['a_bogus.js', 'x_bogus.js']) {
  await copyFile(new URL(name, bytedanceSource), new URL(name, bytedanceTarget));
}

const pinduoduoSource = new URL('../src/signers/pinduoduo/', import.meta.url);
const pinduoduoTarget = new URL('../dist/signers/pinduoduo/', import.meta.url);
await mkdir(pinduoduoTarget, { recursive: true });
await copyFile(new URL('anti_content.js', pinduoduoSource), new URL('anti_content.js', pinduoduoTarget));
