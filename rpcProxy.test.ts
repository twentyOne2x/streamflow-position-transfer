import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import viteReact from "@vitejs/plugin-react";
import {
  ALLOWED_SOLANA_RPC_METHODS,
  LOCAL_SECURITY_HEADERS,
  createRpcProxyMiddleware,
  type RpcProxyOptions,
} from "./rpcProxy";

type UpstreamReply = (
  body: string,
  headers: IncomingHttpHeaders,
  path: string,
) => { body: string; contentType?: string; status?: number };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function startHarness(reply: UpstreamReply, options: RpcProxyOptions = {}) {
  const upstreamRequests: Array<{ body: string; headers: IncomingHttpHeaders; path: string }> = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const captured = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
        path: request.url ?? "",
      };
      upstreamRequests.push(captured);
      const result = reply(captured.body, captured.headers, captured.path);
      response.statusCode = result.status ?? 200;
      response.setHeader("Content-Type", result.contentType ?? "application/json");
      response.end(result.body);
    });
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = new URL(`http://127.0.0.1:${upstreamPort}/rpc`);
  const proxy = createServer(createRpcProxyMiddleware(upstreamUrl, options));
  const proxyPort = await listen(proxy);
  const origin = `http://127.0.0.1:${proxyPort}`;

  const request = async (
    body: string,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    await fetch(`${origin}/solana-rpc`, {
      body: method === "POST" ? body : undefined,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...headers,
      },
      method,
    });

  return { origin, proxyPort, request, upstreamRequests, upstreamUrl };
}

function rpcRequest(method = "getGenesisHash", id: number | string = 1): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params: [] });
}

async function sendChunkedRequest(origin: string, chunks: readonly string[]) {
  const url = new URL("/solana-rpc", origin);
  return await new Promise<{ body: string; status: number }>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "Transfer-Encoding": "chunked",
        },
        method: "POST",
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(responseChunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function sendSlowRejectedRequest(origin: string) {
  const url = new URL("/solana-rpc", origin);
  return await new Promise<{ body: string; status: number }>((resolve, reject) => {
    const request = httpRequest(url, {
      headers: {
        "Content-Length": "1000000",
        "Content-Type": "application/json",
        Origin: "https://example.invalid",
      },
      method: "POST",
    });
    let result: { body: string; status: number } | null = null;
    const timer = setTimeout(() => reject(new Error("Rejected slow request did not close.")), 2_000);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        result = {
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        };
      });
    });
    request.on("error", () => undefined);
    request.on("close", () => {
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(new Error("Rejected slow request closed before its generic response."));
    });
    request.flushHeaders();
    request.write("{");
  });
}

describe("strict Solana JSON-RPC proxy", () => {
  it("forwards an allowed single request without browser credential-bearing headers", async () => {
    const harness = await startHarness((body) => ({
      body: JSON.stringify({ id: JSON.parse(body).id, jsonrpc: "2.0", result: "mainnet" }),
    }));

    const response = await harness.request(rpcRequest("getGenesisHash", "request-1"), {
      Referer: `${harness.origin}/positions`,
      "Sec-Fetch-Site": "same-origin",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "request-1", jsonrpc: "2.0", result: "mainnet" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(harness.upstreamRequests).toHaveLength(1);
    expect(JSON.parse(harness.upstreamRequests[0].body)).toEqual({
      id: "request-1",
      jsonrpc: "2.0",
      method: "getGenesisHash",
      params: [],
    });
    expect(harness.upstreamRequests[0].headers.origin).toBeUndefined();
    expect(harness.upstreamRequests[0].headers.referer).toBeUndefined();
  });

  it("exposes exactly the RPC methods used by every application Connection call", () => {
    const connectionMethodToRpc = {
      getAccountInfo: "getAccountInfo",
      getAccountInfoAndContext: "getAccountInfo",
      getBalanceAndContext: "getBalance",
      getBlockHeight: "getBlockHeight",
      getFeeForMessage: "getFeeForMessage",
      getGenesisHash: "getGenesisHash",
      getLatestBlockhashAndContext: "getLatestBlockhash",
      getMinimumBalanceForRentExemption: "getMinimumBalanceForRentExemption",
      getMultipleAccountsInfoAndContext: "getMultipleAccounts",
      getSignatureStatus: "getSignatureStatuses",
      getSlot: "getSlot",
      getTransaction: "getTransaction",
      sendRawTransaction: "sendTransaction",
      simulateTransaction: "simulateTransaction",
    } as const;
    const sourceDirectory = new URL("./src/", import.meta.url);
    const productionSources = readdirSync(sourceDirectory).filter(
      (file) => /\.(?:ts|tsx)$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
    );
    const calledConnectionMethods = new Set<string>();
    for (const file of productionSources) {
      const source = readFileSync(new URL(file, sourceDirectory), "utf8");
      for (const match of source.matchAll(/\bconnection\.(\w+)\s*\(/g)) {
        calledConnectionMethods.add(match[1]);
      }
    }

    expect([...calledConnectionMethods].sort()).toEqual(Object.keys(connectionMethodToRpc).sort());
    expect([...new Set(Object.values(connectionMethodToRpc))].sort()).toEqual(
      [...ALLOWED_SOLANA_RPC_METHODS].sort(),
    );
    expect([...ALLOWED_SOLANA_RPC_METHODS].sort()).toEqual([
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
    ]);
  });

  it.each([
    ["missing origin", {}],
    ["foreign origin", { Origin: "https://example.invalid" }],
    ["cross-site fetch metadata", { "Sec-Fetch-Site": "cross-site" }],
    ["foreign referer", { Referer: "https://example.invalid/" }],
  ])("rejects %s before contacting the upstream", async (_label, headers) => {
    const harness = await startHarness(() => ({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }),
    }));
    const response =
      _label === "missing origin"
        ? await fetch(`${harness.origin}/solana-rpc`, {
            body: rpcRequest(),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        : await harness.request(rpcRequest(), headers);

    expect(response.status).toBe(403);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("closes a rejected slow-body connection without waiting for the body", async () => {
    const harness = await startHarness(() => ({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }),
    }));

    const response = await sendSlowRejectedRequest(harness.origin);

    expect(response.status).toBe(403);
    expect(response.body).toContain("RPC request rejected.");
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it.each([
    ["a batch", JSON.stringify([JSON.parse(rpcRequest())]), {}],
    ["a notification", JSON.stringify({ jsonrpc: "2.0", method: "getGenesisHash", params: [] }), {}],
    ["an unneeded method", rpcRequest("getProgramAccounts"), {}],
    ["an extra envelope field", JSON.stringify({ ...JSON.parse(rpcRequest()), extra: true }), {}],
    ["malformed JSON", "{", {}],
    ["a compressed body", rpcRequest(), { "Content-Encoding": "gzip" }],
  ])("rejects %s before contacting the upstream", async (_label, body, headers) => {
    const harness = await startHarness(() => ({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }),
    }));

    const response = await harness.request(body, headers);

    expect([400, 415]).toContain(response.status);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("rejects non-POST and non-JSON requests", async () => {
    const harness = await startHarness(() => ({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }),
    }));

    const getResponse = await harness.request("", {}, "GET");
    const textResponse = await harness.request(rpcRequest(), { "Content-Type": "text/plain" });

    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(textResponse.status).toBe(415);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it.each(["/solana-rpc/extra", "/solana-rpc?method=getGenesisHash"])(
    "rejects the non-exact endpoint path %s",
    async (path) => {
      const harness = await startHarness(() => ({
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }),
      }));

      const response = await fetch(`${harness.origin}${path}`, {
        body: rpcRequest(),
        headers: { "Content-Type": "application/json", Origin: harness.origin },
        method: "POST",
      });

      expect(response.status).toBe(404);
      expect(harness.upstreamRequests).toHaveLength(0);
    },
  );

  it("enforces the request body cap", async () => {
    const harness = await startHarness(
      () => ({ body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }) }),
      { requestBodyLimitBytes: 64 },
    );

    const response = await harness.request(`${rpcRequest()}${" ".repeat(65)}`);

    expect(response.status).toBe(413);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("enforces the request body cap for chunked bodies without Content-Length", async () => {
    const harness = await startHarness(
      () => ({ body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: null }) }),
      { requestBodyLimitBytes: 64 },
    );

    const response = await sendChunkedRequest(harness.origin, ["{".repeat(40), "}".repeat(40)]);

    expect(response.status).toBe(413);
    expect(response.body).not.toContain("127.0.0.1");
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("enforces the provider response cap", async () => {
    const harness = await startHarness(
      () => ({ body: JSON.stringify({ id: 1, jsonrpc: "2.0", result: "x".repeat(256) }) }),
      { responseBodyLimitBytes: 128 },
    );

    const response = await harness.request(rpcRequest());

    expect(response.status).toBe(502);
    expect((await response.text()).length).toBeLessThan(256);
  });

  it.each([
    ["a mismatched id", { id: 2, jsonrpc: "2.0", result: null }, "application/json"],
    ["a batch response", [{ id: 1, jsonrpc: "2.0", result: null }], "application/json"],
    ["a non-JSON media type", { id: 1, jsonrpc: "2.0", result: null }, "text/plain"],
  ])("rejects %s", async (_label, value, contentType) => {
    const harness = await startHarness(() => ({ body: JSON.stringify(value), contentType }));

    const response = await harness.request(rpcRequest());

    expect(response.status).toBe(502);
  });

  it("does not relay a provider URL credential echoed by the upstream", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: { code: -32000, message: `provider failed at ${request.url}` },
          id: 1,
          jsonrpc: "2.0",
        }),
      );
    });
    const upstreamPort = await listen(upstream);
    const secret = "short7x";
    const proxy = createServer(
      createRpcProxyMiddleware(new URL(`http://127.0.0.1:${upstreamPort}/rpc?api-key=${secret}`)),
    );
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    const response = await fetch(`${origin}/solana-rpc`, {
      body: rpcRequest(),
      headers: { "Content-Type": "application/json", Origin: origin },
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain(secret);
    expect(body).not.toContain("api-key");
  });

  it("does not mistake a short non-credential provider option for a response secret", async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: 1, jsonrpc: "2.0", result: "ok" }));
    });
    const upstreamPort = await listen(upstream);
    const proxy = createServer(
      createRpcProxyMiddleware(new URL(`http://127.0.0.1:${upstreamPort}/rpc?api-version=1`)),
    );
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    const response = await fetch(`${origin}/solana-rpc`, {
      body: rpcRequest(),
      headers: { "Content-Type": "application/json", Origin: origin },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1, jsonrpc: "2.0", result: "ok" });
  });

  it("rate-limits repeated requests before they reach a credentialed provider", async () => {
    const harness = await startHarness(
      (body) => ({ body: JSON.stringify({ id: JSON.parse(body).id, jsonrpc: "2.0", result: null }) }),
      { maxRequestsPerMinute: 1 },
    );

    expect((await harness.request(rpcRequest())).status).toBe(200);
    const limited = await harness.request(rpcRequest("getSlot", 2));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(harness.upstreamRequests).toHaveLength(1);
  });
});

describe("Vite security boundary", () => {
  it("installs the strict middleware for both dev and preview", () => {
    const source = readFileSync(new URL("./vite.config.ts", import.meta.url), "utf8");

    expect(source).toContain("configureServer(server)");
    expect(source).toContain("configurePreviewServer(server)");
    expect(source).not.toContain("server: {\n      proxy:");
  });

  it("ships a CSP without eval or external network access", () => {
    const csp = LOCAL_SECURITY_HEADERS["Content-Security-Policy"];
    const reactPreambleHash = createHash("sha256")
      .update(viteReact.preambleCode.replace("__BASE__", "/"))
      .digest("base64");

    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`'sha256-${reactPreambleHash}'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:/);
  });
});
