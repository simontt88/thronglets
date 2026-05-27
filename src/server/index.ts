import { createServer } from "http";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createHttpApp } from "./http.js";
import { attachWebSocket } from "./ws.js";
import type { FleetManager } from "../fleet/index.js";
import type { FleetEventBus } from "../fleet/index.js";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceEntry } from "../fleet/index.js";

const DEFAULT_PORT = 3847;

function findDashboardDist(): string | null {
  // Try relative to this file (works in dev and built mode)
  const candidates = [
    resolve(fileURLToPath(import.meta.url), "../../../packages/dashboard/dist"),
    resolve(process.cwd(), "packages/dashboard/dist"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

function findChillDir(): string | null {
  const candidates = [
    resolve(fileURLToPath(import.meta.url), "../../../packages/dashboard/dist/chill"),
    resolve(fileURLToPath(import.meta.url), "../../../packages/dashboard/public/chill"),
    resolve(process.cwd(), "packages/dashboard/dist/chill"),
    resolve(process.cwd(), "packages/dashboard/public/chill"),
    resolve(process.cwd(), "thronglets-viz"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

export function createServerApp(
  fleet: FleetManager,
  config: BridgeConfig,
): express.Application {
  const app = createHttpApp(fleet, config);

  // Serve chill mode (thronglets-viz) static files
  const chillDir = findChillDir();
  if (chillDir) {
    app.use("/chill", express.static(chillDir));
    console.log(`[server] Chill mode: serving from ${chillDir}`);
  }

  // Serve dashboard static files if built
  const dashDir = findDashboardDist();
  if (dashDir) {
    app.use(express.static(dashDir));
    // SPA fallback: any non-API route serves index.html
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path.startsWith("/chill") || req.path === "/health") {
        return next();
      }
      res.sendFile(join(dashDir, "index.html"));
    });
    console.log(`[server] Dashboard: serving from ${dashDir}`);
  } else {
    // Dashboard not built — serve a helpful fallback page
    app.get("/", (_req, res) => {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Thronglets</title>
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#333}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:0.9em}
pre{background:#f1f5f9;padding:16px;border-radius:8px;overflow-x:auto}</style></head>
<body><h1>Thronglets</h1><p>The API is running but the dashboard hasn't been built yet.</p>
<pre>cd packages/dashboard\nnpm install\nnpm run build</pre>
<p>Then restart the service. Or use <strong>Telegram</strong> to interact with the fleet.</p>
<p><a href="/health">API Health</a> · <a href="/api/fleet">Fleet Status</a></p></body></html>`);
    });
    console.log("[server] Dashboard: not built — serving fallback page. Run: cd packages/dashboard && npm install && npm run build");
  }

  return app;
}

export function listenServer(
  app: express.Application,
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
  port: number,
): import("http").Server {
  const server = createServer(app);
  attachWebSocket(server, fleet, bus, config, workspaces);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[server] API: http://127.0.0.1:${port}`);
    console.log(`[server] WS:  ws://127.0.0.1:${port}/ws`);
  });
  return server;
}

export function startServer(
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): { port: number; server: import("http").Server } {
  const port = parseInt(process.env.BRIDGE_PORT || "") || DEFAULT_PORT;
  const app = createServerApp(fleet, config);
  const server = listenServer(app, fleet, bus, config, workspaces, port);
  return { port, server };
}
