import type { HttpRequestSpec } from './types.js';

export interface HttpExecutionResult {
  ok: boolean;
  statusCode?: number;
  body?: unknown;
  durationMs: number;
  timedOut: boolean;
  networkError: boolean;
  errorMessage?: string;
}

export async function executeHttpRequest(
  spec: HttpRequestSpec,
  options: {
    timeoutMs: number;
    headers?: Record<string, string>;
  }
): Promise<HttpExecutionResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const requestInit: RequestInit = {
      method: spec.method,
      headers: {
        'content-type': 'application/json',
        ...(spec.headers ?? {}),
        ...(options.headers ?? {})
      },
      signal: controller.signal
    };

    if (spec.body !== undefined) {
      requestInit.body = JSON.stringify(spec.body);
    }

    const response = await fetch(spec.url, requestInit);

    const contentType = response.headers.get('content-type') ?? '';
    let parsed: unknown;

    if (contentType.includes('application/json')) {
      parsed = await response.json().catch(() => undefined);
    } else {
      parsed = await response.text().catch(() => undefined);
    }

    return {
      ok: response.ok,
      statusCode: response.status,
      body: parsed,
      durationMs: Date.now() - started,
      timedOut: false,
      networkError: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = message.toLowerCase().includes('abort');
    return {
      ok: false,
      durationMs: Date.now() - started,
      timedOut,
      networkError: !timedOut,
      errorMessage: message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
