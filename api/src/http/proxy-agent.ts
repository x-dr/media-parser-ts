import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export interface ProxyEndpoint {
  address: string;
  host: string;
  port: number;
}

class HttpConnectAgent extends http.Agent {
  readonly #proxy: ProxyEndpoint;
  readonly #timeoutMs: number;

  public constructor(proxy: ProxyEndpoint, timeoutMs: number) {
    super({ keepAlive: false });
    this.#proxy = proxy;
    this.#timeoutMs = timeoutMs;
  }

  public override createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: net.Socket) => void,
  ): net.Socket {
    const targetHost = options.host ?? options.hostname ?? '';
    const targetPort = Number(options.port ?? 80);
    openConnectTunnel(this.#proxy, targetHost, targetPort, this.#timeoutMs)
      .then((socket) => callback?.(null, socket))
      .catch((error: unknown) => {
        callback?.(error instanceof Error ? error : new Error('代理隧道建立失败'), null as unknown as net.Socket);
      });
    return null as unknown as net.Socket;
  }
}

class HttpsConnectAgent extends https.Agent {
  readonly #proxy: ProxyEndpoint;
  readonly #timeoutMs: number;

  public constructor(proxy: ProxyEndpoint, timeoutMs: number) {
    super({ keepAlive: false });
    this.#proxy = proxy;
    this.#timeoutMs = timeoutMs;
  }

  public override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: net.Socket) => void,
  ): net.Socket {
    const targetHost = options.host ?? options.hostname ?? '';
    const targetPort = Number(options.port ?? 443);
    openConnectTunnel(this.#proxy, targetHost, targetPort, this.#timeoutMs)
      .then((socket) => {
        const tlsSocket = tls.connect({
          socket,
          servername: typeof options.servername === 'string' && options.servername ? options.servername : targetHost,
          rejectUnauthorized: true,
        });
        callback?.(null, tlsSocket);
      })
      .catch((error: unknown) => {
        callback?.(error instanceof Error ? error : new Error('代理 TLS 隧道建立失败'), null as unknown as net.Socket);
      });
    return null as unknown as net.Socket;
  }
}

function openConnectTunnel(
  proxy: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let headerBuffer = Buffer.alloc(0);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs, () => {
      fail(new Error('代理连接超时'));
    });
    socket.once('error', fail);

    socket.once('connect', () => {
      const authority = targetHost.includes(':') ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n`,
      );
    });

    const onData = (chunk: Buffer): void => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      if (headerBuffer.length > 16_384) {
        socket.off('data', onData);
        fail(new Error('代理响应头过大'));
        return;
      }
      const endIndex = headerBuffer.indexOf('\r\n\r\n');
      if (endIndex < 0) return;
      socket.off('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      const statusLine = headerBuffer.subarray(0, endIndex).toString('latin1').split('\r\n')[0] ?? '';
      if (!/^HTTP\/1\.[01]\s+200\b/iu.test(statusLine)) {
        fail(new Error(`代理 CONNECT 被拒绝：${statusLine.slice(0, 64)}`));
        return;
      }
      const remainder = headerBuffer.subarray(endIndex + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      settled = true;
      resolve(socket);
    };

    socket.on('data', onData);
  });
}

export function createProxyAgents(
  proxy: ProxyEndpoint,
  timeoutMs: number,
): { http: http.Agent; https: https.Agent } {
  return {
    http: new HttpConnectAgent(proxy, timeoutMs),
    https: new HttpsConnectAgent(proxy, timeoutMs),
  };
}
