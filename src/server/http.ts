import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { FleetManager } from "../fleet/index.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { getSessionsDir } from "../fleet/state.js";
import { DISPATCHER_NAME, POKE_MESSAGE_WITH_GOAL, POKE_MESSAGE_NO_GOAL } from "../utils/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = pkg.version as string;
const startTime = Date.now();

export function createHttpApp(
  fleet: FleetManager,
  config: BridgeConfig,
): express.Application {
  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  app.get("/health", (_req, res) => {
    const status = fleet.getStatus();
    res.json({
      ok: true,
      version: VERSION,
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
      waiting: status.waiting,
      sleeping: status.sleeping,
      workspaces: fleet.listWorkspaces().map((w) => ({ alias: w.alias, path: w.path })),
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

  app.get("/api/agents/:name/tail", (req, res) => {
    const name = req.params.name;
    if (!fleet.hasAgent(name)) {
      res.status(404).json({ error: `Agent "${name}" not found` });
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 5, 50);
    const agent = fleet.getAgent(name)!;
    const sessionsDir = getSessionsDir(name);
    try {
      const sessionFile = `${sessionsDir}/${agent.currentSessionId}.jsonl`;
      const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
      const events = lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json({ sessionId: agent.currentSessionId, events });
    } catch {
      res.json({ sessionId: agent.currentSessionId, events: [] });
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
    const rt = (runtime || config.agents[0]?.runtime || "cursor") as RuntimeType;
    const wsList = fleet.listWorkspaces();
    const ws = workspace || wsList[0]?.alias || "cwd";
    const result = await fleet.spawn(name || undefined, rt, ws, model);
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

  app.post("/api/agents/:name/clear", async (req, res) => {
    const name = req.params.name;
    if (!fleet.hasAgent(name)) {
      res.status(404).json({ error: `Agent "${name}" not found` });
      return;
    }
    const result = await fleet.clear(name);
    res.json({ message: result });
  });

  app.get("/api/dispatcher/status", (_req, res) => {
    const dispatcher = fleet.getAgent(DISPATCHER_NAME);
    res.json({
      enabled: !!config.dispatcher?.enabled,
      running: !!dispatcher,
      agent: dispatcher || null,
    });
  });

  app.post("/api/fleet/change", async (req, res) => {
    const { name, field, value } = req.body;
    if (!name || !field || !value) {
      res.status(400).json({ error: "name, field, and value are required" });
      return;
    }
    const result = await fleet.change(name, field, value, config, fleet.listWorkspaces());
    res.json({ message: result });
  });

  app.post("/api/workspaces", (req, res) => {
    const { alias, path } = req.body;
    if (!alias || !path) {
      res.status(400).json({ error: "alias and path are required" });
      return;
    }
    const result = fleet.addWorkspace(alias, path);
    res.json({ message: result, workspaces: fleet.listWorkspaces() });
  });

  app.patch("/api/workspaces/:alias", (req, res) => {
    const oldAlias = req.params.alias;
    const { alias: newAlias } = req.body;
    if (!newAlias) {
      res.status(400).json({ error: "alias is required" });
      return;
    }
    const result = fleet.renameWorkspace(oldAlias, newAlias);
    if (result.startsWith("Error") || result.includes("not found")) {
      res.status(400).json({ error: result });
      return;
    }
    res.json({ message: result, workspaces: fleet.listWorkspaces() });
  });

  app.delete("/api/workspaces/:alias", (req, res) => {
    const alias = req.params.alias;
    const status = fleet.getStatus();
    const occupants = status.agents.filter((a) => a.workspace === alias);
    if (occupants.length > 0) {
      res.status(409).json({
        error: `Cannot delete workspace "${alias}" — ${occupants.length} throng(s) still inside: ${occupants.map((a) => a.name).join(", ")}. Kill them first.`,
        agents: occupants.map((a) => a.name),
      });
      return;
    }
    const result = fleet.removeWorkspace(alias);
    res.json({ message: result, workspaces: fleet.listWorkspaces() });
  });

  app.post("/api/agents/:name/title", (req, res) => {
    const { title } = req.body;
    const result = fleet.setTitle(req.params.name, title || "");
    res.json({ message: result });
  });

  app.post("/api/fleet/poke", async (_req, res) => {
    if (!fleet.hasAgent(DISPATCHER_NAME)) {
      res.status(503).json({ error: "Dispatcher is offline" });
      return;
    }
    const goal = fleet.getGoal();
    const msg = goal ? POKE_MESSAGE_WITH_GOAL : POKE_MESSAGE_NO_GOAL;
    fleet.send(DISPATCHER_NAME, msg, "user").catch(() => {});
    res.json({ ok: true, message: "Dispatcher poked" });
  });

  app.get("/api/fleet/goal", (_req, res) => {
    res.json({ goal: fleet.getGoal() });
  });

  app.post("/api/fleet/goal", (req, res) => {
    const { goal } = req.body;
    if (typeof goal !== "string") {
      res.status(400).json({ error: "goal (string) is required" });
      return;
    }
    fleet.setGoal(goal);
    res.json({ ok: true, goal });
  });

  return app;
}
