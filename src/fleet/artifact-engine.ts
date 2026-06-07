/**
 * ArtifactEngine — turns the fleet's tool-call telemetry into a living "atlas"
 * of workspace artifacts, scored and ranked like RPG loot.
 *
 * Where GameEngine treats each *throng* as a character (XP / level / mood), this
 * treats each *file* a throng touches as a collectible item. An artifact's
 * rarity rises as more sessions and more throngs use it — so the load-bearing
 * files of a workspace surface as Legendary relics, and the network effect
 * (more sessions → sharper centrality) becomes a visible progression.
 *
 * Two data sources, one handler:
 *   • live  — subscribes to the fleet bus `tool_call` events (gateway-normalized
 *             for codex / claude-code / native, with full tool input).
 *   • replay— ingests persisted ThrongTrace JSONL on startup so the atlas is
 *             populated even with zero live throngs.
 *
 * Pure logic over events — fully testable without any live API.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { FleetEventBus } from "./manager.js";
import type { FleetEvent } from "./types.js";

// ─── involvement & rarity vocab ──────────────────────────────────────────────

export type Involvement = "read" | "edit" | "create" | "search";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

/** Item flavor: extension → material, involvement → how it's wielded. */
export type ArtifactClass = "tome" | "rune" | "crystal" | "tool" | "relic";

export interface ArtifactItem {
  id: string;            // display id (last path segments)
  path: string;          // best-known full path
  workspace: string;
  klass: ArtifactClass;
  rarity: Rarity;
  level: number;         // 1..99, log-scaled centrality
  score: number;         // raw centrality (count or pagerank)
  read: number;
  edit: number;
  create: number;
  search: number;
  sessionCount: number;
  discoverers: string[]; // throngs that touched it
  firstDiscoveredBy: string;
  firstSeen: string;
  lastSeen: string;
  live: boolean;         // touched within the glow window
}

interface ArtifactStat {
  id: string;
  path: string;
  read: number;
  edit: number;
  create: number;
  search: number;
  sessions: Set<string>;
  discoverers: Set<string>;
  firstDiscoveredBy: string;
  firstSeen: string;
  lastSeen: string;
  lastTouch: number;     // epoch ms, for live glow
}

interface WorkspaceAtlas {
  artifacts: Map<string, ArtifactStat>;
  adj: Map<string, Map<string, number>>;  // co-occurrence (for pagerank mode)
  sessionArtifacts: Map<string, Set<string>>; // session → artifact ids seen
}

export type ScoringMode = "count" | "pagerank";
export type WorkspaceResolver = (agentName: string) => string;

const GLOW_WINDOW_MS = 20_000;

// ─── path / artifact id helpers ──────────────────────────────────────────────

const FILE_EXT_RE = /\.(?:py|ts|tsx|js|jsx|go|java|rs|rb|php|c|h|cpp|cs|swift|kt|scala|sh|bash|zsh|sql|md|markdown|txt|rst|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html|css|env)$/i;

/** A loose matcher for file-like tokens inside a shell command. */
const SHELL_FILE_RE = /[\w./@~-]*\/[\w./@~-]+\.[a-z0-9]{1,6}\b|\b[\w@-]+\.(?:py|ts|tsx|js|jsx|go|java|rs|rb|sh|sql|md|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html|css|env)\b/gi;

function looksLikeFile(p: string): boolean {
  return FILE_EXT_RE.test(p);
}

/** Normalize an absolute/relative path into a stable, readable id (tail 2 segs). */
function toId(p: string): string | null {
  if (!p) return null;
  const clean = String(p).split("?")[0].replace(/\\/g, "/").replace(/^['"]|['"]$/g, "").replace(/[)>,;]+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length) return null;
  const base = parts[parts.length - 1];
  if (!looksLikeFile(base)) return null;
  return parts.slice(-2).join("/");
}

// ─── tool → (involvement, files) extraction ──────────────────────────────────

const READ_TOOLS = /^(read_file|read|cat|view|open|notebook_read)$/i;
const CREATE_TOOLS = /^(write_file|write|create_file|create)$/i;
const EDIT_TOOLS = /^(edit_file|edit|multiedit|str_replace|search_replace|apply_patch|notebook_edit)$/i;
const SEARCH_TOOLS = /^(grep|glob|search_files|codebase_search|file_search|search)$/i;
const SHELL_TOOLS = /^(run_bash|bash|shell|run_command|run_terminal_cmd|execute_command)$/i;

interface Touch { id: string; path: string; kind: Involvement }

/** Classify the verb leading a shell pipeline segment. */
function shellVerbKind(verb: string): Involvement | "run" | null {
  if (/^(cat|head|tail|less|more|bat|view|wc|jq|nl|od)$/.test(verb)) return "read";
  if (/^(ls|find|grep|rg|ag|fd|tree|locate)$/.test(verb)) return "search";
  if (/^(sed|tee|cp|mv|touch|truncate)$/.test(verb)) return "edit";
  if (/^(python3?|node|deno|bun|bash|sh|pytest|npm|pnpm|yarn|make|cargo|go)$/.test(verb)) return "run";
  return null;
}

function shellTouches(cmd: string): Touch[] {
  const out: Touch[] = [];
  if (!cmd) return out;
  for (const seg of String(cmd).split(/&&|\|\||;|\|/)) {
    const verb = (seg.match(/^\s*([a-z_0-9]+)/i) || [])[1] || "";
    let kind = shellVerbKind(verb.toLowerCase());
    // output redirection implies an edit/create on the target
    const redir = seg.match(/>>?\s*([\w./@~-]+\.[a-z0-9]{1,6})/i);
    const matched = seg.match(SHELL_FILE_RE) || [];
    const effKind: Involvement = kind === "run" || kind == null ? "read" : kind;
    for (const f of matched) {
      const id = toId(f);
      if (id) out.push({ id, path: f, kind: effKind });
    }
    if (redir) { const id = toId(redir[1]); if (id) out.push({ id, path: redir[1], kind: "edit" }); }
  }
  return out;
}

/** Extract artifact touches from a single tool call (name + raw input). */
export function extractTouches(name: string, input: Record<string, unknown>): Touch[] {
  const n = String(name || "");
  const pushPath = (p: unknown, kind: Involvement, out: Touch[]) => {
    if (typeof p !== "string") return;
    const id = toId(p);
    if (id) out.push({ id, path: p, kind });
  };
  const out: Touch[] = [];

  if (READ_TOOLS.test(n)) {
    pushPath(input.path ?? input.file_path, "read", out);
    if (Array.isArray(input.files_read)) for (const f of input.files_read) pushPath(f, "read", out);
  } else if (CREATE_TOOLS.test(n)) {
    pushPath(input.path ?? input.file_path, "create", out);
  } else if (EDIT_TOOLS.test(n)) {
    pushPath(input.path ?? input.file_path, "edit", out);
  } else if (SEARCH_TOOLS.test(n)) {
    for (const key of ["glob", "pattern", "path", "query"]) {
      const v = input[key];
      if (typeof v === "string") for (const f of v.match(SHELL_FILE_RE) || []) pushPath(f, "search", out);
    }
  } else if (SHELL_TOOLS.test(n)) {
    const cmd = (input.command ?? input.cmd ?? input.input) as unknown;
    if (typeof cmd === "string") out.push(...shellTouches(cmd));
  }
  return out;
}

// ─── classification & rarity ─────────────────────────────────────────────────

function classify(id: string): ArtifactClass {
  const ext = (id.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (/^(md|markdown|txt|rst)$/.test(ext)) return "tome";
  if (/^(ya?ml|toml|ini|cfg|conf|env)$/.test(ext)) return "rune";
  if (/^(json|jsonl|csv|tsv|xml)$/.test(ext)) return "crystal";
  if (/^(py|ts|tsx|js|jsx|go|java|rs|rb|php|c|h|cpp|cs|swift|kt|scala|sh|bash|sql)$/.test(ext)) return "tool";
  return "relic";
}

/**
 * Tie-safe percentile rarity: the crowd at the bottom stays common, the tiers
 * above earn rarer bands, and a clear top outlier (≥2× the runner-up) is
 * crowned legendary — the workspace's "Excalibur".
 */
function rarityFor(score: number, allScores: number[], distinctDesc: number[]): Rarity {
  if (score <= 0 || allScores.length === 0) return "common";
  // promote a dominant top score to legendary (needs a real runner-up to beat)
  const top = distinctDesc[0] ?? 0;
  const second = distinctDesc[1] ?? 0;
  if (distinctDesc.length > 1 && score === top && top >= 2 * second) return "legendary";

  // percentile = fraction of artifacts STRICTLY below this score (ties → crowd)
  let weaker = 0;
  for (const s of allScores) if (s < score) weaker++;
  const pctile = weaker / allScores.length; // 1 = best, 0 = tied-at-bottom
  if (pctile >= 0.98) return "legendary";
  if (pctile >= 0.92) return "epic";
  if (pctile >= 0.80) return "rare";
  if (pctile >= 0.50) return "uncommon";
  return "common";
}

/** Log-scaled 1..99 item level from raw score against the workspace max. */
function levelFor(score: number, max: number): number {
  if (score <= 0 || max <= 0) return 1;
  const lvl = Math.round((Math.log(1 + score) / Math.log(1 + max)) * 98) + 1;
  return Math.max(1, Math.min(99, lvl));
}

// ─── engine ──────────────────────────────────────────────────────────────────

export class ArtifactEngine {
  private spaces = new Map<string, WorkspaceAtlas>();
  private resolveWorkspace: WorkspaceResolver;
  private scoring: ScoringMode;

  constructor(bus: FleetEventBus | null, opts: { resolveWorkspace?: WorkspaceResolver; scoring?: ScoringMode } = {}) {
    this.resolveWorkspace = opts.resolveWorkspace || (() => "unknown");
    this.scoring = opts.scoring || "count";
    if (bus) bus.onEvent((e) => this.onEvent(e));
  }

  setScoring(mode: ScoringMode): void { this.scoring = mode; }

  private atlasFor(workspace: string): WorkspaceAtlas {
    let a = this.spaces.get(workspace);
    if (!a) {
      a = { artifacts: new Map(), adj: new Map(), sessionArtifacts: new Map() };
      this.spaces.set(workspace, a);
    }
    return a;
  }

  /** Core ingest: one tool call attributed to (agent, session, workspace, ts). */
  ingestToolCall(args: {
    agent: string; session: string; workspace: string;
    name: string; input: Record<string, unknown>; ts: string;
  }): void {
    const { agent, session, workspace, name, input, ts } = args;
    const touches = extractTouches(name, input);
    if (!touches.length) return;
    const atlas = this.atlasFor(workspace);
    const tms = Date.parse(ts) || Date.now();

    let sessSet = atlas.sessionArtifacts.get(session);
    if (!sessSet) { sessSet = new Set(); atlas.sessionArtifacts.set(session, sessSet); }

    for (const t of touches) {
      let st = atlas.artifacts.get(t.id);
      if (!st) {
        st = {
          id: t.id, path: t.path, read: 0, edit: 0, create: 0, search: 0,
          sessions: new Set(), discoverers: new Set(),
          firstDiscoveredBy: agent, firstSeen: ts, lastSeen: ts, lastTouch: tms,
        };
        atlas.artifacts.set(t.id, st);
      }
      st[t.kind]++;
      st.sessions.add(session);
      if (agent && agent !== "unknown") st.discoverers.add(agent);
      if (t.path.length > st.path.length) st.path = t.path; // keep the most complete path
      st.lastSeen = ts;
      if (tms > st.lastTouch) st.lastTouch = tms;
      sessSet.add(t.id);
    }

    // co-occurrence edges within the session (for pagerank scoring mode)
    const ids = [...sessSet];
    for (const a of touches.map((x) => x.id)) {
      for (const b of ids) {
        if (a === b) continue;
        this.bump(atlas.adj, a, b);
        this.bump(atlas.adj, b, a);
      }
    }
  }

  private bump(adj: Map<string, Map<string, number>>, a: string, b: string): void {
    let m = adj.get(a);
    if (!m) { m = new Map(); adj.set(a, m); }
    m.set(b, (m.get(b) || 0) + 1);
  }

  private onEvent(e: FleetEvent): void {
    if (e.type !== "tool_call") return;
    const agent = e.agentName;
    if (!agent || agent === "unknown" || agent.startsWith("_")) return;
    const tool = (e.payload as { tool?: { name: string; input: Record<string, unknown> } } | undefined)?.tool;
    if (!tool?.name) return;
    this.ingestToolCall({
      agent,
      session: e.sessionId || "live",
      workspace: this.resolveWorkspace(agent),
      name: tool.name,
      input: tool.input || {},
      ts: e.ts || new Date().toISOString(),
    });
  }

  // ─── startup replay from persisted JSONL traces ────────────────────────────

  /** Replay every persisted ThrongTrace tool_call under a traces root dir. */
  ingestTraceDir(root: string): { files: number; calls: number } {
    let files = 0, calls = 0;
    let agentDirs: string[];
    try { agentDirs = readdirSync(root); } catch { return { files, calls }; }
    for (const agentDir of agentDirs) {
      const agentPath = join(root, agentDir);
      let sessionFiles: string[];
      try {
        if (!statSync(agentPath).isDirectory()) continue;
        sessionFiles = readdirSync(agentPath).filter((f) => f.endsWith(".jsonl"));
      } catch { continue; }
      const workspace = this.resolveWorkspace(agentDir);
      for (const sf of sessionFiles) {
        files++;
        const session = sf.replace(/\.jsonl$/, "");
        let lines: string[];
        try { lines = readFileSync(join(agentPath, sf), "utf8").split("\n"); } catch { continue; }
        for (const line of lines) {
          if (!line.trim()) continue;
          let trace: { kind?: string; tool?: { name: string; input: Record<string, unknown> }; ts?: string };
          try { trace = JSON.parse(line); } catch { continue; }
          if (trace.kind !== "tool_call" || !trace.tool?.name) continue;
          this.ingestToolCall({
            agent: agentDir, session, workspace,
            name: trace.tool.name, input: trace.tool.input || {},
            ts: trace.ts || new Date().toISOString(),
          });
          calls++;
        }
      }
    }
    return { files, calls };
  }

  // ─── scoring & serving ─────────────────────────────────────────────────────

  private pagerank(atlas: WorkspaceAtlas, d = 0.85, iters = 40): Map<string, number> {
    const nodes = [...atlas.artifacts.keys()];
    const N = nodes.length;
    const idx = new Map(nodes.map((n, i) => [n, i]));
    let pr = new Float64Array(N).fill(N ? 1 / N : 0);
    for (let it = 0; it < iters; it++) {
      const nx = new Float64Array(N);
      let dangling = 0;
      for (let i = 0; i < N; i++) nx[i] = (1 - d) / (N || 1);
      for (let i = 0; i < N; i++) {
        const nb = atlas.adj.get(nodes[i]);
        if (!nb || nb.size === 0) { dangling += pr[i]; continue; }
        let w = 0; for (const v of nb.values()) w += v;
        for (const [m, v] of nb) nx[idx.get(m)!] += d * pr[i] * (v / w);
      }
      for (let i = 0; i < N; i++) nx[i] += d * dangling / (N || 1);
      pr = nx;
    }
    return new Map(nodes.map((n, i) => [n, pr[i]]));
  }

  private scoreOf(atlas: WorkspaceAtlas): Map<string, number> {
    if (this.scoring === "pagerank") return this.pagerank(atlas);
    // count mode: session frequency (how many distinct sessions used it)
    const m = new Map<string, number>();
    for (const [id, st] of atlas.artifacts) m.set(id, st.sessions.size);
    return m;
  }

  /** Build the served item list for a workspace, with rarity/level resolved. */
  private itemsFor(workspace: string, atlas: WorkspaceAtlas): ArtifactItem[] {
    const scores = this.scoreOf(atlas);
    const allScores = [...scores.values()];
    const sortedDesc = [...allScores].sort((a, b) => b - a);
    const distinctDesc = [...new Set(sortedDesc)];
    const max = sortedDesc[0] || 0;
    const now = Date.now();
    const items: ArtifactItem[] = [];
    for (const [id, st] of atlas.artifacts) {
      const score = scores.get(id) || 0;
      items.push({
        id, path: st.path, workspace,
        klass: classify(id),
        rarity: rarityFor(score, allScores, distinctDesc),
        level: levelFor(score, max),
        score,
        read: st.read, edit: st.edit, create: st.create, search: st.search,
        sessionCount: st.sessions.size,
        discoverers: [...st.discoverers],
        firstDiscoveredBy: st.firstDiscoveredBy,
        firstSeen: st.firstSeen, lastSeen: st.lastSeen,
        live: now - st.lastTouch <= GLOW_WINDOW_MS,
      });
    }
    return items.sort((a, b) => b.score - a.score);
  }

  /** Atlas for one workspace (default all), sorted by score desc. */
  getAtlas(workspace?: string): ArtifactItem[] {
    if (workspace) {
      const a = this.spaces.get(workspace);
      return a ? this.itemsFor(workspace, a) : [];
    }
    const all: ArtifactItem[] = [];
    for (const [ws, atlas] of this.spaces) all.push(...this.itemsFor(ws, atlas));
    return all.sort((a, b) => b.score - a.score);
  }

  /** Compact per-workspace summary for badges / overview. */
  getSummary(): Record<string, { artifacts: number; sessions: number; legendary: number; live: number }> {
    const out: Record<string, { artifacts: number; sessions: number; legendary: number; live: number }> = {};
    for (const [ws, atlas] of this.spaces) {
      const items = this.itemsFor(ws, atlas);
      out[ws] = {
        artifacts: items.length,
        sessions: atlas.sessionArtifacts.size,
        legendary: items.filter((i) => i.rarity === "legendary").length,
        live: items.filter((i) => i.live).length,
      };
    }
    return out;
  }

  workspaces(): string[] { return [...this.spaces.keys()]; }
}
