/**
 * Headless render via Chrome DevTools Protocol.
 *
 * Talks raw CDP over WebSocket — no playwright, no agent-browser, no extra deps.
 * Connects to the env-configured browser endpoint, opens a fresh target per call,
 * waits for network idle, captures the post-JS HTML, and closes the target.
 *
 * Returns null on any error (timeout, navigation failure, CDP disconnect).
 */

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_DWELL_MS = 1_500;
const NETWORK_IDLE_MS = 1_500;
const VERSION_FETCH_TIMEOUT_MS = 5_000;

export type RenderResult = { html: string; finalUrl: string };

export type RenderOptions = {
  timeoutMs?: number;
  dwellMs?: number;
};

type Json = Record<string, unknown>;

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code?: number; message?: string };
  sessionId?: string;
};

type Pending = {
  resolve: (value: Json) => void;
  reject: (reason: Error) => void;
};

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Map<string, Set<(params: Json, sessionId?: string) => void>>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', () => this.onClose(new Error('CDP socket closed')));
    this.ws.addEventListener('error', () => this.onClose(new Error('CDP socket errored')));
  }

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timeout after ${timeoutMs}ms`));
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP socket failed to open'));
        },
        { once: true },
      );
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new Error('CDP client closed'));
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload: Json = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, handler: (params: Json, sessionId?: string) => void): () => void {
    const set = this.eventListeners.get(method) ?? new Set();
    set.add(handler);
    this.eventListeners.set(method, set);
    return () => {
      set.delete(handler);
    };
  }

  close(): void {
    this.onClose(new Error('CDP client closed by caller'));
  }

  private onMessage(event: MessageEvent): void {
    let parsed: CdpMessage;
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(`CDP error ${parsed.error.code ?? '?'}: ${parsed.error.message ?? 'unknown'}`));
      } else {
        pending.resolve(parsed.result ?? {});
      }
      return;
    }

    if (parsed.method) {
      const listeners = this.eventListeners.get(parsed.method);
      if (!listeners) {
        return;
      }
      for (const listener of listeners) {
        try {
          listener(parsed.params ?? {}, parsed.sessionId);
        } catch {
          // swallow listener errors; we don't want to drop the socket
        }
      }
    }
  }

  private onClose(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function resolveBrowserWsUrl(envValue: string): Promise<string> {
  const trimmed = envValue.trim();
  if (!trimmed) {
    throw new Error('TOMMYATO_BROWSER_CDP_URL is empty');
  }

  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    throw new Error(`Unsupported CDP URL scheme: ${trimmed}`);
  }

  const versionUrl = new URL('/json/version', trimmed).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(versionUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`/json/version returned ${response.status}`);
    }
    const data = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (typeof data.webSocketDebuggerUrl !== 'string') {
      throw new Error('/json/version missing webSocketDebuggerUrl');
    }
    // Rewrite host:port to match the configured base (containers reach the
    // host through host.docker.internal but Chrome reports localhost).
    const reported = new URL(data.webSocketDebuggerUrl);
    const base = new URL(trimmed);
    reported.host = base.host;
    return reported.toString();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForNetworkIdle(
  inFlight: { count: number },
  options: { timeoutMs: number; idleMs: number; startedAt: number },
): Promise<void> {
  const deadline = options.startedAt + options.timeoutMs;
  let lastBusyAt = Date.now();

  while (true) {
    const now = Date.now();
    if (now >= deadline) {
      throw new Error('navigation timeout waiting for network idle');
    }

    if (inFlight.count > 0) {
      lastBusyAt = now;
    } else if (now - lastBusyAt >= options.idleMs) {
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a URL via headless Chrome and return the post-JS HTML.
 *
 * Returns null on any failure mode: missing env var, connect failure, navigation
 * timeout, network-idle timeout, evaluate failure, or close errors. Never throws.
 *
 * Each call opens a new target via `Target.createTarget` and closes it on exit —
 * does not reuse existing tabs (those may be authenticated or in-use by other
 * processes).
 */
export async function renderViaCdp(
  url: string,
  opts: RenderOptions = {},
): Promise<RenderResult | null> {
  const envValue = process.env.TOMMYATO_BROWSER_CDP_URL;
  if (!envValue) {
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dwellMs = opts.dwellMs ?? DEFAULT_DWELL_MS;

  let client: CdpClient | null = null;
  let targetId: string | null = null;
  let sessionId: string | null = null;

  try {
    const wsUrl = await resolveBrowserWsUrl(envValue);
    client = await CdpClient.connect(wsUrl, VERSION_FETCH_TIMEOUT_MS);

    const createResult = (await client.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId?: string;
    };
    if (typeof createResult.targetId !== 'string') {
      return null;
    }
    targetId = createResult.targetId;

    const attachResult = (await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (typeof attachResult.sessionId !== 'string') {
      return null;
    }
    sessionId = attachResult.sessionId;

    const inFlight = { count: 0 };
    const inFlightIds = new Set<string>();
    const startMessageMatchesSession = (msgSessionId: string | undefined): boolean =>
      msgSessionId === sessionId;

    const offRequest = client.on('Network.requestWillBeSent', (params, msgSessionId) => {
      if (!startMessageMatchesSession(msgSessionId)) {
        return;
      }
      const requestId = typeof params.requestId === 'string' ? params.requestId : null;
      if (requestId && !inFlightIds.has(requestId)) {
        inFlightIds.add(requestId);
        inFlight.count += 1;
      }
    });
    const finishHandler = (params: Json, msgSessionId?: string) => {
      if (!startMessageMatchesSession(msgSessionId)) {
        return;
      }
      const requestId = typeof params.requestId === 'string' ? params.requestId : null;
      if (requestId && inFlightIds.delete(requestId)) {
        inFlight.count = Math.max(0, inFlight.count - 1);
      }
    };
    const offFinished = client.on('Network.loadingFinished', finishHandler);
    const offFailed = client.on('Network.loadingFailed', finishHandler);

    try {
      await client.send('Page.enable', {}, sessionId);
      await client.send('Network.enable', {}, sessionId);

      const startedAt = Date.now();
      await client.send('Page.navigate', { url }, sessionId);
      await waitForNetworkIdle(inFlight, {
        timeoutMs,
        idleMs: NETWORK_IDLE_MS,
        startedAt,
      });
      await sleep(dwellMs);

      const htmlResult = (await client.send(
        'Runtime.evaluate',
        {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        },
        sessionId,
      )) as { result?: { value?: unknown } };
      const html =
        htmlResult.result && typeof htmlResult.result.value === 'string'
          ? htmlResult.result.value
          : null;

      const urlResult = (await client.send(
        'Runtime.evaluate',
        {
          expression: 'location.href',
          returnByValue: true,
        },
        sessionId,
      )) as { result?: { value?: unknown } };
      const finalUrl =
        urlResult.result && typeof urlResult.result.value === 'string'
          ? urlResult.result.value
          : null;

      if (!html || !finalUrl) {
        return null;
      }

      return { html, finalUrl };
    } finally {
      offRequest();
      offFinished();
      offFailed();
    }
  } catch {
    return null;
  } finally {
    if (client && targetId) {
      try {
        await client.send('Target.closeTarget', { targetId });
      } catch {
        // ignore
      }
    }
    if (client) {
      client.close();
    }
  }
}

// Internal exports for unit tests — not part of the public API.
export const __test = {
  CdpClient,
  resolveBrowserWsUrl,
  waitForNetworkIdle,
};
