import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FleetEventBus } from "../src/fleet/manager.js";
import { ArtifactEngine, extractTouches } from "../src/fleet/artifact-engine.js";

// ─── extraction ──────────────────────────────────────────────────────────────

describe("extractTouches", () => {
  it("reads file paths from Read/Write/Edit tools with the right involvement", () => {
    expect(extractTouches("read_file", { path: "src/a.ts" })).toEqual([{ id: "src/a.ts", path: "src/a.ts", kind: "read" }]);
    expect(extractTouches("Write", { file_path: "x/b.py" })[0].kind).toBe("create");
    expect(extractTouches("edit_file", { path: "c/d.yaml" })[0].kind).toBe("edit");
  });

  it("captures files_read arrays (claude-code Read)", () => {
    const t = extractTouches("Read", { files_read: ["a/one.md", "a/two.md"] });
    expect(t.map((x) => x.id)).toEqual(["a/one.md", "a/two.md"]);
    expect(t.every((x) => x.kind === "read")).toBe(true);
  });

  it("parses shell commands: cat→read, ls→search, sed→edit, redirection→edit", () => {
    const cat = extractTouches("run_bash", { command: "cat projects/risk/rules_v6.yaml" });
    expect(cat).toEqual([{ id: "risk/rules_v6.yaml", path: "projects/risk/rules_v6.yaml", kind: "read" }]);

    const ls = extractTouches("Bash", { command: "ls results/iteration_5/summary.json" });
    expect(ls[0].kind).toBe("search");

    const redir = extractTouches("shell", { command: "python gen.py > out/report.md" });
    const kinds = Object.fromEntries(redir.map((t) => [t.id, t.kind]));
    expect(kinds["out/report.md"]).toBe("edit");
  });

  it("pulls file tokens out of grep patterns/globs", () => {
    const g = extractTouches("Grep", { glob: "**/run_benchmark.py", pattern: "" });
    expect(g.some((t) => t.id.endsWith("run_benchmark.py") && t.kind === "search")).toBe(true);
  });

  it("ignores tool calls with no file-like arguments", () => {
    expect(extractTouches("run_bash", { command: "echo hi && git status" })).toEqual([]);
    expect(extractTouches("Grep", { pattern: "TODO" })).toEqual([]);
  });
});

// ─── engine: live ingest, rarity, level ──────────────────────────────────────

function busEngine() {
  const bus = new FleetEventBus();
  const engine = new ArtifactEngine(bus, { resolveWorkspace: () => "risk" });
  const call = (agent: string, session: string, name: string, input: Record<string, unknown>) =>
    bus.publish("tool_call", agent, session, { tool: { id: "t", name, input, summary: name } });
  return { engine, call };
}

describe("ArtifactEngine — live ingest", () => {
  it("aggregates touches into the workspace atlas", () => {
    const { engine, call } = busEngine();
    call("Bob", "s1", "read_file", { path: "data/CHANGELOG.md" });
    call("Bob", "s1", "edit_file", { path: "data/CHANGELOG.md" });
    call("Nova", "s2", "read_file", { path: "data/CHANGELOG.md" });

    const atlas = engine.getAtlas("risk");
    const item = atlas.find((a) => a.id === "data/CHANGELOG.md")!;
    expect(item.read).toBe(2);
    expect(item.edit).toBe(1);
    expect(item.sessionCount).toBe(2);
    expect(item.discoverers.sort()).toEqual(["Bob", "Nova"]);
    expect(item.firstDiscoveredBy).toBe("Bob");
    expect(item.klass).toBe("tome");
  });

  it("ignores dispatcher/system agents", () => {
    const { engine, call } = busEngine();
    call("_dispatcher", "s", "read_file", { path: "a.ts" });
    expect(engine.getAtlas("risk")).toHaveLength(0);
  });

  it("ranks the most-shared file as legendary and a one-off as common", () => {
    const { engine, call } = busEngine();
    // hub: touched across 12 sessions
    for (let i = 0; i < 12; i++) call("Bob", `s${i}`, "read_file", { path: "scripts/run_benchmark.py" });
    // a spread of one-off files so percentile bands are meaningful
    for (let i = 0; i < 30; i++) call("Bob", `s${i}`, "read_file", { path: `misc/file_${i}.py` });

    const atlas = engine.getAtlas("risk");
    const hub = atlas.find((a) => a.id === "scripts/run_benchmark.py")!;
    const oneoff = atlas.find((a) => a.id === "misc/file_0.py")!;
    expect(hub.rarity).toBe("legendary");
    expect(hub.level).toBeGreaterThan(oneoff.level);
    expect(oneoff.rarity).toBe("common");
  });

  it("classifies item types from extension", () => {
    const { engine, call } = busEngine();
    call("Bob", "s", "read_file", { path: "a/conf.yaml" });
    call("Bob", "s", "read_file", { path: "a/data.json" });
    call("Bob", "s", "read_file", { path: "a/main.py" });
    call("Bob", "s", "read_file", { path: "a/notes.md" });
    const byId = Object.fromEntries(engine.getAtlas("risk").map((a) => [a.id, a.klass]));
    expect(byId["a/conf.yaml"]).toBe("rune");
    expect(byId["a/data.json"]).toBe("crystal");
    expect(byId["a/main.py"]).toBe("tool");
    expect(byId["a/notes.md"]).toBe("tome");
  });

  it("count and pagerank modes agree on the top hub", () => {
    const { engine, call } = busEngine();
    for (let i = 0; i < 8; i++) {
      call("Bob", `s${i}`, "read_file", { path: "core/hub.py" });
      call("Bob", `s${i}`, "read_file", { path: `leaf/leaf_${i}.py` });
    }
    const topCount = engine.getAtlas("risk")[0].id;
    engine.setScoring("pagerank");
    const topPr = engine.getAtlas("risk")[0].id;
    expect(topCount).toBe("core/hub.py");
    expect(topPr).toBe("core/hub.py");
  });

  it("summary reports artifact/session/legendary counts per workspace", () => {
    const { engine, call } = busEngine();
    for (let i = 0; i < 12; i++) call("Bob", `s${i}`, "read_file", { path: "core/hub.py" });
    for (let i = 0; i < 20; i++) call("Bob", `s${i}`, "read_file", { path: `leaf/l_${i}.py` });
    const s = engine.getSummary().risk;
    expect(s.artifacts).toBe(21);
    expect(s.sessions).toBe(20);
    expect(s.legendary).toBeGreaterThanOrEqual(1);
  });
});

// ─── engine: startup replay from JSONL traces ────────────────────────────────

describe("ArtifactEngine — trace replay", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "atlas-traces-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("ingests persisted tool_call traces from disk", async () => {
    const agentDir = join(root, "Bob");
    await mkdir(agentDir, { recursive: true });
    const lines = [
      { agent: "Bob", session: "s1", ts: "2026-06-03T00:00:00Z", kind: "tool_call", tool: { id: "1", name: "read_file", input: { path: "data/CHANGELOG.md" }, summary: "" } },
      { agent: "Bob", session: "s1", ts: "2026-06-03T00:00:01Z", kind: "usage", usage: {} },
      { agent: "Bob", session: "s1", ts: "2026-06-03T00:00:02Z", kind: "tool_call", tool: { id: "2", name: "run_bash", input: { command: "cat scripts/run_benchmark.py" }, summary: "" } },
    ].map((o) => JSON.stringify(o)).join("\n");
    await writeFile(join(agentDir, "s1.jsonl"), lines + "\n");

    const engine = new ArtifactEngine(null, { resolveWorkspace: () => "risk" });
    const stats = engine.ingestTraceDir(root);
    expect(stats.files).toBe(1);
    expect(stats.calls).toBe(2);

    const ids = engine.getAtlas("risk").map((a) => a.id).sort();
    expect(ids).toEqual(["data/CHANGELOG.md", "scripts/run_benchmark.py"]);
  });

  it("returns zero counts for a missing traces dir", () => {
    const engine = new ArtifactEngine(null);
    expect(engine.ingestTraceDir(join(root, "nope"))).toEqual({ files: 0, calls: 0 });
  });
});
