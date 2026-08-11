import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import {
  LOCAL_SECURITY_HEADERS,
  RPC_PROXY_PATH,
  createRpcProxyMiddleware,
} from "./rpcProxy";

const stripExternalWalletFontImport = {
  postcssPlugin: "strip-external-wallet-font-import",
  AtRule(rule: { name: string; params: string; remove(): void }) {
    if (rule.name === "import" && rule.params.includes("fonts.googleapis.com")) rule.remove();
  },
};

export function rpcProxyPlugin(mainnetRpcUrl: URL): Plugin {
  const install = (middlewares: { use(path: string, handler: ReturnType<typeof createRpcProxyMiddleware>): void }) => {
    middlewares.use(RPC_PROXY_PATH, createRpcProxyMiddleware(mainnetRpcUrl));
  };

  return {
    name: "strict-solana-rpc-proxy",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "SOLANA_RPC_HTTP_URL_MAINNET");
  let mainnetRpcUrl: URL;
  try {
    mainnetRpcUrl = new URL(
      env.SOLANA_RPC_HTTP_URL_MAINNET ?? "https://api.mainnet-beta.solana.com",
    );
  } catch {
    throw new Error("SOLANA_RPC_HTTP_URL_MAINNET must be a valid absolute URL.");
  }

  return {
    css: {
      postcss: {
        plugins: [stripExternalWalletFontImport],
      },
    },
    plugins: [
      react(),
      rpcProxyPlugin(mainnetRpcUrl),
      nodePolyfills({
        include: ["buffer"],
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
        protocolImports: true,
      }),
    ],
    server: {
      headers: LOCAL_SECURITY_HEADERS,
    },
    preview: {
      headers: LOCAL_SECURITY_HEADERS,
    },
  };
});
