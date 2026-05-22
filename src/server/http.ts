import express from "express";
import { join } from "path";
import type { FleetManager } from "../fleet/index.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import type { WorkspaceEntry } from "../fleet/index.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { getSessionsDir } from "../fleet/state.js";

const startTime = Date.now();

export function createHttpApp(
  fleet: FleetManager,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): express.Application {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const status = fleet.getStatus();
    res.json({
      ok: true,
      version: "0.5.0",
      uptime: Math.round((Date.now() - startTime) / 1000),
      agents: status.total,
      working: status.working,
    });
  });

  app.get("/api/fleet", (_req, res) => {
    const status = fleet.getStatus();
    res.json({
      agents: status.agents,
      total: status.total,
      working: status.working,
      idle: status.idle,
      workspaces: workspaces.map((w) => ({ alias: w.alias, path: w.path })),
      runtimes: config.agents.map((a) => ({ name: a.name, runtime: a.runtime, model: a.model })),
    });
  });

  app.get("/api/agents/:name", (req, res) => {
    const agent = fleet.getAgent(req.params.name);
    if (!agent) {
      res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      return;
    }
    res.json(agent);
  });

  app.get("/api/agents/:name/events", (req, res) => {
    const name = req.params.name;
    if (!fleet.hasAgent(name)) {
      res.status(404).json({ error: `Agent "${name}" not found` });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const sessionId = (req.query.session as string) || fleet.getAgent(name)!.currentSessionId;
    const sessionsDir = getSessionsDir(name);

    try {
      const sessionFile = `${sessionsDir}/${sessionId}.jsonl`;
      const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
      const events = lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json({ sessionId, events, total: lines.length });
    } catch {
      res.json({ sessionId, events: [], total: 0 });
    }
  });

  app.get("/api/agents/:name/sessions", (req, res) => {
    const name = req.params.name;
    const sessionsDir = getSessionsDir(name);
    try {
      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(".jsonl", ""))
        .sort()
        .reverse();
      res.json({ agent: name, sessions: files });
    } catch {
      res.json({ agent: name, sessions: [] });
    }
  });

  app.post("/api/agents/:name/send", async (req, res) => {
    const name = req.params.name;
    const { text } = req.body;

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (!fleet.hasAgent(name)) {
      res.status(404).json({ error: `Agent "${name}" not found` });
      return;
    }

    try {
      const reply = await fleet.send(name, text);
      res.json({ agent: name, reply });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/fleet/spawn", async (req, res) => {
    const { name, runtime, workspace, model } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const rt = (runtime || config.agents[0]?.runtime || "cursor") as RuntimeType;
    const ws = workspace || workspaces[0]?.alias || "cwd";
    const result = await fleet.spawn(name, rt, ws, model);
    const success = !result.includes("already exists") && !result.includes("Unknown");
    res.status(success ? 201 : 400).json({ message: result, success });
  });

  app.post("/api/fleet/kill", async (req, res) => {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const result = await fleet.kill(name);
    res.json({ message: result });
  });

  app.post("/api/fleet/change", async (req, res) => {
    const { name, field, value } = req.body;
    if (!name || !field || !value) {
      res.status(400).json({ error: "name, field, and value are required" });
      return;
    }
    const result = await fleet.change(name, field, value, config, workspaces);
    res.json({ message: result });
  });

  return app;
}
