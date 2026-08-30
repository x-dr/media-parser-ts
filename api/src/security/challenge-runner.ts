import { Buffer } from 'node:buffer';
import { Script, createContext } from 'node:vm';

interface ChallengeInput {
  script: string;
  url: string;
}

const chunks: Uint8Array[] = [];
let total = 0;
for await (const inputChunk of process.stdin) {
  const chunk: unknown = inputChunk;
  if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) process.exit(2);
  const buffer = Buffer.from(chunk);
  total += buffer.length;
  if (total > 300 * 1024) process.exit(2);
  chunks.push(buffer);
}

try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChallengeInput;
  if (typeof input.script !== 'string' || typeof input.url !== 'string') process.exit(2);
  const context = createContext({
    location: { href: input.url, search: '?b=2', pathname: '/s' },
    document: {
      createElement: () => ({ setAttribute: () => undefined, appendChild: () => undefined }),
      getElementsByTagName: () => [{ appendChild: () => undefined }],
      head: { appendChild: () => undefined },
      body: { appendChild: () => undefined },
      cookie: '',
    },
  }, {
    codeGeneration: { strings: true, wasm: false },
  });
  Reflect.set(context, 'window', context);
  new Script(input.script, { filename: 'remote-challenge.js' }).runInContext(context, { timeout: 300 });
  const resultObject = Reflect.get(context, 'r') as { token?: unknown } | undefined;
  const token = resultObject && typeof resultObject.token === 'string' ? resultObject.token : '';
  const rawCookieName: unknown = Reflect.get(context, 'c');
  const cookieName = typeof rawCookieName === 'string' && rawCookieName ? rawCookieName : 'EO-Bot-Js-Token';
  process.stdout.write(JSON.stringify({ token, cookieName }));
} catch (error) {
  // The parent discards stderr; this only makes direct isolated-runner diagnostics actionable.
  process.stderr.write(error instanceof Error ? error.message : 'challenge failed');
  process.exitCode = 1;
}
