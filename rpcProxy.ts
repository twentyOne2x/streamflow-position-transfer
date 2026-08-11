import type { IncomingMessage, ServerResponse } from "node:http";

export const RPC_PROXY_PATH = "/solana-rpc";
export const RPC_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
export const RPC_RESPONSE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export const ALLOWED_SOLANA_RPC_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getSlot",
  "getTransaction",
  "sendTransaction",
  "simulateTransaction",
] as const);

export const LOCAL_SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'sha256-8ZgGo/nOlaDknQkDUYiedLuFRSGJwIz6LAzsOrNxhmU='",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join("; "),
  "Permissions-Policy":
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

type FetchLike = typeof fetch;

export type RpcProxyOptions = {
  fetchImpl?: FetchLike;
  maxConcurrentRequests?: number;
  maxRequestsPerMinute?: number;
  requestBodyLimitBytes?: number;
  responseBodyLimitBytes?: number;
  upstreamTimeoutMs?: number;
};

type JsonRpcRequest = {
  id: number | string;
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
};

type RateWindow = {
  count: number;
  startedAt: number;
};

class RequestBodyLimitError extends Error {}
class RequestBodyTimeoutError extends Error {}
class ResponseBodyLimitError extends Error {}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]";
}

function assertSafeUpstreamUrl(url: URL): void {
  if (url.hash || url.username || url.password) {
    throw new Error("The Solana RPC URL must not contain a fragment or user-info credentials.");
  }

  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return;
  throw new Error("The Solana RPC URL must use HTTPS (or loopback HTTP for local development).");
}

function isSameLoopbackOrigin(request: IncomingMessage): boolean {
  const host = singleHeader(request.headers.host);
  const origin = singleHeader(request.headers.origin);
  if (!host || !origin) return false;

  try {
    const originUrl = new URL(origin);
    if (!isLoopbackHostname(originUrl.hostname)) return false;
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;
    if (originUrl.host !== host || originUrl.origin !== origin) return false;

    const referer = singleHeader(request.headers.referer);
    if (referer && new URL(referer).origin !== originUrl.origin) return false;

    const fetchSite = singleHeader(request.headers["sec-fetch-site"]);
    return !fetchSite || fetchSite === "same-origin";
  } catch {
    return false;
  }
}

function isExactProxyPath(request: IncomingMessage): boolean {
  const originalUrl = (request as IncomingMessage & { originalUrl?: string }).originalUrl;
  try {
    const url = new URL(originalUrl ?? request.url ?? "", "http://127.0.0.1");
    return url.pathname === RPC_PROXY_PATH && url.search === "";
  } catch {
    return false;
  }
}

function parseContentLength(request: IncomingMessage): number | undefined {
  const value = singleHeader(request.headers["content-length"]);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return Number.NaN;
  return Number(value);
}

async function readRequestBody(
  request: IncomingMessage,
  limitBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const declaredLength = parseContentLength(request);
  if (Number.isNaN(declaredLength) || (declaredLength !== undefined && declaredLength > limitBytes)) {
    request.resume();
    throw new RequestBodyLimitError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      request.off("aborted", onAborted);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, length));
    };
    const onAborted = () => finish(new Error("Request aborted."));
    const onError = () => finish(new Error("Request stream failed."));
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limitBytes) {
        finish(new RequestBodyLimitError());
        request.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish();
    const timer = setTimeout(() => {
      finish(new RequestBodyTimeoutError());
      request.resume();
    }, timeoutMs);

    request.on("aborted", onAborted);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

function parseJsonRpcRequest(body: Buffer): JsonRpcRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["id", "jsonrpc", "method", "params"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  if (record.jsonrpc !== "2.0") return null;
  if (
    (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) &&
    (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128)
  ) {
    return null;
  }
  if (typeof record.method !== "string" || !ALLOWED_SOLANA_RPC_METHODS.has(record.method as never)) {
    return null;
  }
  if (!Array.isArray(record.params)) return null;

  return record as JsonRpcRequest;
}

async function readResponseBody(response: Response, limitBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > limitBytes)) {
    await response.body?.cancel();
    throw new ResponseBodyLimitError();
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limitBytes) {
      await reader.cancel();
      throw new ResponseBodyLimitError();
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function idsMatch(left: unknown, right: number | string): boolean {
  return (typeof left === "number" || typeof left === "string") && Object.is(left, right);
}

function isValidJsonRpcResponse(value: unknown, requestId: number | string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || !idsMatch(record.id, requestId)) return false;
  const allowedKeys = new Set(["error", "id", "jsonrpc", "result"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  return hasResult !== hasError && (!hasError || (!!record.error && typeof record.error === "object"));
}

function isSensitiveQueryParameter(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "auth" ||
    normalized === "authorization" ||
    normalized === "credential" ||
    normalized === "key" ||
    normalized === "password" ||
    normalized === "projectid" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function credentialFragments(url: URL): string[] {
  const fragments = new Set<string>();
  fragments.add(url.href);
  fragments.add(url.host);
  if (url.search) fragments.add(`${url.pathname}${url.search}`);
  if (url.pathname !== "/") {
    fragments.add(url.pathname);
    try {
      fragments.add(decodeURIComponent(url.pathname));
    } catch {
      // The URL parser already validated the encoded path; the encoded form remains protected.
    }
  }
  url.searchParams.forEach((value, name) => {
    if (value && (value.length >= 8 || isSensitiveQueryParameter(name))) fragments.add(value);
  });
  for (const parameter of url.search.slice(1).split("&")) {
    const [encodedName, encodedValue] = parameter.split("=", 2);
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      // Retain the encoded name for conservative classification.
    }
    if (encodedValue && (encodedValue.length >= 8 || isSensitiveQueryParameter(name))) {
      fragments.add(encodedValue);
    }
  }
  for (const label of url.hostname.split(".")) {
    if (label.length >= 8) fragments.add(label);
  }
  for (const segment of url.pathname.split("/")) {
    if (segment.length >= 16) fragments.add(segment);
  }
  return Array.from(fragments);
}

function containsCredentialFragment(serialized: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => serialized.includes(fragment));
}

function applyRpcResponseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: number | string | null = null,
): void {
  if (response.writableEnded) return;
  applyRpcResponseHeaders(response);
  response.statusCode = status;
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
}

function closeAfterEarlyRejection(request: IncomingMessage, response: ServerResponse): void {
  if (request.complete) return;
  response.setHeader("Connection", "close");
  response.once("finish", () => request.destroy());
  request.resume();
}

export function createRpcProxyMiddleware(upstream: URL, options: RpcProxyOptions = {}) {
  const upstreamUrl = new URL(upstream.href);
  assertSafeUpstreamUrl(upstreamUrl);

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 8;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 180;
  const requestBodyLimitBytes = options.requestBodyLimitBytes ?? RPC_REQUEST_BODY_LIMIT_BYTES;
  const responseBodyLimitBytes = options.responseBodyLimitBytes ?? RPC_RESPONSE_BODY_LIMIT_BYTES;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 20_000;
  const credentialNeedles = credentialFragments(upstreamUrl);
  const rateWindows = new Map<string, RateWindow>();
  let concurrentRequests = 0;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isExactProxyPath(request)) {
      closeAfterEarlyRejection(request, response);
      sendJsonRpcError(response, 404, -32600, "RPC request rejected.");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      closeAfterEarlyRejection(request, response);
      sendJsonRpcError(response, 405, -32600, "RPC request rejected.");
      return;
    }
    if (!isSameLoopbackOrigin(request)) {
      closeAfterEarlyRejection(request, response);
      sendJsonRpcError(response, 403, -32600, "RPC request rejected.");
      return;
    }

    const contentType = singleHeader(request.headers["content-type"]);
    const contentEncoding = singleHeader(request.headers["content-encoding"]);
    if (
      !contentType ||
      !/^application\/json(?:\s*;|$)/i.test(contentType) ||
      contentEncoding !== undefined
    ) {
      closeAfterEarlyRejection(request, response);
      sendJsonRpcError(response, 415, -32600, "RPC request rejected.");
      return;
    }

    const now = Date.now();
    const client = request.socket.remoteAddress ?? "unknown";
    let rateWindow = rateWindows.get(client);
    if (!rateWindow || now - rateWindow.startedAt >= 60_000) {
      rateWindow = { count: 0, startedAt: now };
      rateWindows.set(client, rateWindow);
    }
    rateWindow.count += 1;
    if (rateWindow.count > maxRequestsPerMinute || concurrentRequests >= maxConcurrentRequests) {
      response.setHeader("Retry-After", "60");
      closeAfterEarlyRejection(request, response);
      sendJsonRpcError(response, 429, -32005, "RPC request temporarily unavailable.");
      return;
    }

    concurrentRequests += 1;
    try {
      let body: Buffer;
      try {
        body = await readRequestBody(request, requestBodyLimitBytes, 10_000);
      } catch (error) {
        closeAfterEarlyRejection(request, response);
        if (error instanceof RequestBodyLimitError) {
          sendJsonRpcError(response, 413, -32600, "RPC request rejected.");
        } else if (error instanceof RequestBodyTimeoutError) {
          sendJsonRpcError(response, 408, -32600, "RPC request rejected.");
        } else {
          sendJsonRpcError(response, 400, -32600, "RPC request rejected.");
        }
        return;
      }

      const rpcRequest = parseJsonRpcRequest(body);
      if (!rpcRequest) {
        sendJsonRpcError(response, 400, -32600, "RPC request rejected.");
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      try {
        const upstreamResponse = await fetchImpl(upstreamUrl, {
          body: JSON.stringify(rpcRequest),
          cache: "no-store",
          credentials: "omit",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: controller.signal,
        });

        const upstreamContentType = upstreamResponse.headers.get("content-type");
        if (!upstreamContentType || !/^application\/json(?:\s*;|$)/i.test(upstreamContentType)) {
          await upstreamResponse.body?.cancel();
          sendJsonRpcError(response, 502, -32603, "RPC provider returned an invalid response.", rpcRequest.id);
          return;
        }

        let upstreamBody: Buffer;
        try {
          upstreamBody = await readResponseBody(upstreamResponse, responseBodyLimitBytes);
        } catch {
          sendJsonRpcError(response, 502, -32603, "RPC provider returned an invalid response.", rpcRequest.id);
          return;
        }

        let upstreamValue: unknown;
        try {
          upstreamValue = JSON.parse(upstreamBody.toString("utf8"));
        } catch {
          sendJsonRpcError(response, 502, -32603, "RPC provider returned an invalid response.", rpcRequest.id);
          return;
        }

        if (!isValidJsonRpcResponse(upstreamValue, rpcRequest.id)) {
          sendJsonRpcError(response, 502, -32603, "RPC provider returned an invalid response.", rpcRequest.id);
          return;
        }

        if (Object.prototype.hasOwnProperty.call(upstreamValue, "error")) {
          const providerStatus = upstreamResponse.status >= 400 ? upstreamResponse.status : 502;
          sendJsonRpcError(response, providerStatus, -32603, "RPC provider rejected the request.", rpcRequest.id);
          return;
        }

        const serialized = JSON.stringify(upstreamValue);
        if (
          Buffer.byteLength(serialized) > responseBodyLimitBytes ||
          containsCredentialFragment(serialized, credentialNeedles)
        ) {
          sendJsonRpcError(response, 502, -32603, "RPC provider returned an invalid response.", rpcRequest.id);
          return;
        }

        applyRpcResponseHeaders(response);
        response.statusCode = upstreamResponse.status >= 400 ? upstreamResponse.status : 200;
        response.end(serialized);
      } catch {
        sendJsonRpcError(response, 502, -32603, "RPC provider is unavailable.", rpcRequest.id);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      concurrentRequests -= 1;
    }
  };
}
