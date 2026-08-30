import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ChallengeResult {
  token: string;
  cookieName: string;
}

export class ChallengeExecutor {
  #active = 0;

  public constructor(
    private readonly maxConcurrent = 2,
    private readonly timeoutMs = 1_000,
  ) {}

  public async execute(script: string, url: URL, signal: AbortSignal): Promise<ChallengeResult> {
    if (script.length === 0 || script.length > 256 * 1024) throw new Error('挑战脚本长度无效');
    if (this.#active >= this.maxConcurrent) throw new Error('挑战执行器并发已满');
    this.#active += 1;
    try {
      return await this.#spawn(script, url, signal);
    } finally {
      this.#active -= 1;
    }
  }

  async #spawn(script: string, url: URL, signal: AbortSignal): Promise<ChallengeResult> {
    const runner = fileURLToPath(new URL('./challenge-runner.js', import.meta.url));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--permission',
        `--allow-fs-read=${runner}`,
        '--max-old-space-size=32',
        runner,
      ], {
        env: {},
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      const abort = (): void => {
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 8 * 1024) child.kill('SIGKILL');
        else stdout.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (code !== 0) {
          reject(new Error('隔离挑战执行失败'));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as ChallengeResult;
          if (!parsed.token || !parsed.cookieName) throw new Error();
          resolve(parsed);
        } catch {
          reject(new Error('隔离挑战结果无效'));
        }
      });
      child.stdin.end(JSON.stringify({ script, url: url.href }));
    });
  }
}
