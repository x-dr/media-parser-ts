import { platformIds } from '../src/config/platforms.js';
import { defaultPlatformSamples } from '../src/platform-admin/platform-test-samples.js';

interface ParseResponse {
  retcode?: unknown;
  succ?: unknown;
  error_code?: unknown;
  data?: unknown;
}

const nodeEndpoint = endpoint('LIVE_NODE_API_URL');
const pythonEndpoint = endpoint('LIVE_PYTHON_API_URL');
const nodeApiKey = process.env.LIVE_NODE_API_KEY?.trim();
if (!nodeApiKey) throw new Error('LIVE_NODE_API_KEY 未配置');

let nodeSuccesses = 0;
let pythonSuccesses = 0;
for (const platformId of platformIds) {
  const text = defaultPlatformSamples[platformId];
  const [node, python] = await Promise.all([
    invoke(nodeEndpoint, text, nodeApiKey),
    invoke(pythonEndpoint, text),
  ]);
  if (node.success) nodeSuccesses += 1;
  if (python.success) pythonSuccesses += 1;
  process.stdout.write(`${JSON.stringify({
    platform_id: platformId,
    node: node.success ? 'success' : 'failure',
    python: python.success ? 'success' : 'failure',
    node_error: node.errorCode,
    python_error: python.errorCode,
    node_duration_ms: node.durationMs,
    python_duration_ms: python.durationMs,
  })}\n`);
}

process.stdout.write(`${JSON.stringify({
  summary: true,
  node_successes: nodeSuccesses,
  python_successes: pythonSuccesses,
  total: platformIds.length,
  acceptable: nodeSuccesses >= pythonSuccesses,
})}\n`);
if (nodeSuccesses < pythonSuccesses) process.exitCode = 1;

function endpoint(name: string): URL {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} 未配置`);
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} 必须是无凭据的 HTTP(S) URL`);
  }
  if (!url.pathname.endsWith('/api/parse')) {
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/api/parse`;
  }
  return url;
}

async function invoke(
  url: URL,
  text: string,
  apiKey?: string,
): Promise<{ success: boolean; errorCode: string | null; durationMs: number }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as ParseResponse;
    return {
      success: response.ok && payload.succ === true,
      errorCode: typeof payload.error_code === 'string' ? payload.error_code : null,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return { success: false, errorCode: 'NETWORK_OR_INVALID_RESPONSE', durationMs: Date.now() - startedAt };
  }
}
