import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __test, renderViaCdp } from './cdp-render';

const { CdpClient, resolveBrowserWsUrl, waitForNetworkIdle } = __test;

describe('resolveBrowserWsUrl', () => {
  test('passes through ws:// urls unchanged', async () => {
    expect(await resolveBrowserWsUrl('ws://host:1234/devtools/browser/abc')).toBe(
      'ws://host:1234/devtools/browser/abc',
    );
  });

  test('passes through wss:// urls unchanged', async () => {
    expect(await resolveBrowserWsUrl('wss://example.com/devtools/browser/x')).toBe(
      'wss://example.com/devtools/browser/x',
    );
  });

  test('rejects empty value', async () => {
    await expect(resolveBrowserWsUrl('   ')).rejects.toThrow(/empty/);
  });

  test('rejects unsupported schemes', async () => {
    await expect(resolveBrowserWsUrl('ftp://host:9222')).rejects.toThrow(/scheme/);
  });
});

describe('waitForNetworkIdle', () => {
  test('returns once in-flight stays at zero for the idle window', async () => {
    const inFlight = { count: 0 };
    const start = Date.now();
    await waitForNetworkIdle(inFlight, { timeoutMs: 5000, idleMs: 200, startedAt: start });
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  test('throws when the timeout elapses with non-zero in-flight', async () => {
    const inFlight = { count: 1 };
    await expect(
      waitForNetworkIdle(inFlight, { timeoutMs: 250, idleMs: 200, startedAt: Date.now() }),
    ).rejects.toThrow(/timeout/);
  });
});

// FakeWebSocket simulates a CDP server in-process. It accepts JSON commands and
// emits responses + protocol events configured by the test.
type Sent = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: Sent[] = [];
  url: string;
  onResponse: (msg: Sent) => Array<Record<string, unknown>>;
  closed = false;

  constructor(url: string, onResponse: (msg: Sent) => Array<Record<string, unknown>>) {
    super();
    this.url = url;
    this.onResponse = onResponse;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as Sent;
    this.sent.push(parsed);
    const responses = this.onResponse(parsed);
    for (const response of responses) {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) })),
      );
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
}

const realWebSocket = globalThis.WebSocket;

function installFakeWebSocket(handler: (ws: FakeWebSocket) => void): { sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  (globalThis as { WebSocket: unknown }).WebSocket = function FakeWS(url: string) {
    const onResponse = (_msg: Sent): Array<Record<string, unknown>> => [];
    const ws = new FakeWebSocket(url, onResponse);
    sockets.push(ws);
    queueMicrotask(() => handler(ws));
    return ws as unknown as WebSocket;
  } as unknown as typeof WebSocket;
  return { sockets };
}

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe('CdpClient', () => {
  test('round-trips command/response by id', async () => {
    installFakeWebSocket((ws) => {
      ws.onResponse = (msg) => {
        if (msg.id != null && msg.method === 'Runtime.evaluate') {
          return [{ id: msg.id, result: { result: { value: 'ok' } } }];
        }
        return [];
      };
    });

    const client = await CdpClient.connect('ws://fake/browser', 1000);
    const result = (await client.send('Runtime.evaluate', { expression: '1' })) as {
      result?: { value?: unknown };
    };
    expect(result.result?.value).toBe('ok');
    client.close();
  });

  test('rejects pending sends when the socket closes', async () => {
    const socketRef: { ws: FakeWebSocket | null } = { ws: null };
    installFakeWebSocket((ws) => {
      socketRef.ws = ws;
      ws.onResponse = () => [];
    });

    const client = await CdpClient.connect('ws://fake/browser', 1000);
    const pending = client.send('Page.navigate', { url: 'https://example.com' });
    socketRef.ws?.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});

// renderViaCdp full path: an HTTP /json/version response, then a CDP socket
// scripted to simulate Target.createTarget, Target.attachToTarget, Page.enable,
// Network.enable, Page.navigate (with a request lifecycle), and Runtime.evaluate.
describe('renderViaCdp', () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.TOMMYATO_BROWSER_CDP_URL;

  beforeEach(() => {
    process.env.TOMMYATO_BROWSER_CDP_URL = 'http://chrome.local:9223';
    // @ts-expect-error mock fetch
    globalThis.fetch = async (input: string) => {
      if (typeof input === 'string' && input.endsWith('/json/version')) {
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) {
      delete process.env.TOMMYATO_BROWSER_CDP_URL;
    } else {
      process.env.TOMMYATO_BROWSER_CDP_URL = realEnv;
    }
  });

  test('returns null when env var is missing', async () => {
    delete process.env.TOMMYATO_BROWSER_CDP_URL;
    expect(await renderViaCdp('https://example.com')).toBeNull();
  });

  test('extracts html and final url from a scripted CDP session', async () => {
    installFakeWebSocket((ws) => {
      ws.onResponse = (msg) => {
        if (msg.id == null) {
          return [];
        }
        if (msg.method === 'Target.createTarget') {
          return [{ id: msg.id, result: { targetId: 't1' } }];
        }
        if (msg.method === 'Target.attachToTarget') {
          return [{ id: msg.id, result: { sessionId: 's1' } }];
        }
        if (msg.method === 'Page.enable' || msg.method === 'Network.enable') {
          return [{ id: msg.id, result: {} }];
        }
        if (msg.method === 'Page.navigate') {
          return [{ id: msg.id, result: { frameId: 'f1' } }];
        }
        if (msg.method === 'Runtime.evaluate') {
          const params = msg.params ?? {};
          const expr = typeof params.expression === 'string' ? params.expression : '';
          if (expr.includes('outerHTML')) {
            return [
              {
                id: msg.id,
                result: { result: { value: '<html><body>rendered</body></html>' } },
              },
            ];
          }
          return [
            {
              id: msg.id,
              result: { result: { value: 'https://example.com/final' } },
            },
          ];
        }
        if (msg.method === 'Target.closeTarget') {
          return [{ id: msg.id, result: {} }];
        }
        return [{ id: msg.id, result: {} }];
      };
    });

    const result = await renderViaCdp('https://example.com', {
      timeoutMs: 2000,
      dwellMs: 50,
    });
    expect(result).toEqual({
      html: '<html><body>rendered</body></html>',
      finalUrl: 'https://example.com/final',
    });
  });

  test('returns null on a CDP error during attach', async () => {
    installFakeWebSocket((ws) => {
      ws.onResponse = (msg) => {
        if (msg.id == null) {
          return [];
        }
        if (msg.method === 'Target.createTarget') {
          return [{ id: msg.id, result: { targetId: 't1' } }];
        }
        if (msg.method === 'Target.attachToTarget') {
          return [{ id: msg.id, error: { code: -32000, message: 'attach failed' } }];
        }
        return [{ id: msg.id, result: {} }];
      };
    });

    const result = await renderViaCdp('https://example.com', {
      timeoutMs: 1000,
      dwellMs: 10,
    });
    expect(result).toBeNull();
  });

  test('returns null when the socket closes mid-flight', async () => {
    const socketRef: { ws: FakeWebSocket | null } = { ws: null };
    installFakeWebSocket((ws) => {
      socketRef.ws = ws;
      ws.onResponse = (msg) => {
        if (msg.id == null) {
          return [];
        }
        if (msg.method === 'Target.createTarget') {
          queueMicrotask(() => socketRef.ws?.close());
          return [];
        }
        return [{ id: msg.id, result: {} }];
      };
    });

    const result = await renderViaCdp('https://example.com', {
      timeoutMs: 1000,
      dwellMs: 10,
    });
    expect(result).toBeNull();
  });
});
