import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TOOLS_BY_NAME, summarizeToolCall } from "../src/runtimes/native/tools.js";

let cwd: string;

beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "native-tools-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const run = (name: string, input: Record<string, unknown>) => TOOLS_BY_NAME[name].run(input, cwd);

describe("native tools — files", () => {
  it("write_file then read_file round-trips with line numbers", async () => {
    const w = await run("write_file", { path: "a/b.txt", content: "hello\nworld" });
    expect(w.ok).toBe(true);
    expect(await fs.readFile(join(cwd, "a/b.txt"), "utf8")).toBe("hello\nworld");

    const r = await run("read_file", { path: "a/b.txt" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1\thello");
    expect(r.content).toContain("2\tworld");
  });

  it("read_file fails cleanly for a missing file", async () => {
    const r = await run("read_file", { path: "nope.txt" });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/read_file failed/);
  });

  it("edit_file replaces a unique substring", async () => {
    await run("write_file", { path: "x.ts", content: "const a = 1;\nconst b = 2;" });
    const e = await run("edit_file", { path: "x.ts", old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(e.ok).toBe(true);
    expect(await fs.readFile(join(cwd, "x.ts"), "utf8")).toContain("const b = 3;");
  });

  it("edit_file refuses a non-unique old_string", async () => {
    await run("write_file", { path: "x.ts", content: "x\nx\n" });
    const e = await run("edit_file", { path: "x.ts", old_string: "x", new_string: "y" });
    expect(e.ok).toBe(false);
    expect(e.content).toMatch(/appears 2×/);
  });

  it("edit_file reports when old_string is absent", async () => {
    await run("write_file", { path: "x.ts", content: "abc" });
    const e = await run("edit_file", { path: "x.ts", old_string: "zzz", new_string: "y" });
    expect(e.ok).toBe(false);
    expect(e.content).toMatch(/not found/);
  });

  it("list_dir marks directories with a trailing slash", async () => {
    await run("write_file", { path: "dir/inner.txt", content: "1" });
    await run("write_file", { path: "top.txt", content: "1" });
    const l = await run("list_dir", { path: "." });
    expect(l.ok).toBe(true);
    expect(l.content).toContain("dir/");
    expect(l.content).toContain("top.txt");
  });
});

describe("native tools — shell & search", () => {
  it("run_bash captures stdout and flags non-zero exit", async () => {
    const ok = await run("run_bash", { command: "echo hi" });
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("hi");

    const bad = await run("run_bash", { command: "exit 3" });
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("[exit 3]");
  });

  it("grep finds a pattern and reports no-match as ok", async () => {
    await run("write_file", { path: "code.js", content: "function needle() {}\n" });
    const hit = await run("grep", { pattern: "needle", path: "." });
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain("needle");

    const miss = await run("grep", { pattern: "zzz_nomatch_zzz", path: "." });
    expect(miss.ok).toBe(true);
    expect(miss.content).toMatch(/no matches/);
  });
});

describe("native tools — VibeSync session history", () => {
  it("registers recall/workspaces/get_session tools with valid schemas", () => {
    for (const name of ["recall_sessions", "list_session_workspaces", "get_session"]) {
      const t = TOOLS_BY_NAME[name];
      expect(t, name).toBeTruthy();
      expect(t.parameters.type).toBe("object");
    }
    expect(TOOLS_BY_NAME["recall_sessions"].parameters.required).toContain("query");
    expect(TOOLS_BY_NAME["get_session"].parameters.required).toContain("session_id");
  });

  it("errors gracefully when VibeSync has no credentials", async () => {
    const saved = process.env.VIBESYNC_API_KEY;
    const home = process.env.HOME;
    process.env.VIBESYNC_API_KEY = "";
    process.env.HOME = "/nonexistent-home-for-test"; // so the config.json fallback misses
    try {
      const r = await TOOLS_BY_NAME["list_session_workspaces"].run({}, process.cwd());
      expect(r.ok).toBe(false);
      expect(r.content).toMatch(/not configured/i);
    } finally {
      if (saved === undefined) delete process.env.VIBESYNC_API_KEY; else process.env.VIBESYNC_API_KEY = saved;
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    }
  });
});

describe("summarizeToolCall", () => {
  it("renders compact summaries per tool", () => {
    expect(summarizeToolCall("read_file", { path: "a.ts" })).toBe("📖 a.ts");
    expect(summarizeToolCall("run_bash", { command: "npm test\nmore" })).toContain("npm test");
    expect(summarizeToolCall("edit_file", { path: "b.ts" })).toBe("✂️ b.ts");
  });
});
