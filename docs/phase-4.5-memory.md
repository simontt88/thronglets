# Phase 4.5 — Agent Memory Layer (Optional, Pluggable)

> Memory is **opt-in**. Workspaces may already provide their own persistence (e.g. Cursor's
> built-in project context, `.cursor/rules`). The memory layer described here is an
> independent interface that any agent can plug into — from zero-overhead file append
> to full temporal knowledge graphs.

---

## Current State

Fleet sessions are persisted as JSONL at `~/.thronglets/fleet/sessions/{agentName}/`.
Each new agent session automatically captures the full conversation. The legacy
`LocalRecall` module provides basic token-match search over these logs.

**What's missing:**
- Summarized knowledge that survives across sessions (not just raw transcripts)
- Skill/pattern registration (agent learns reusable procedures)
- Configurable backends — from flat file to vector DB to knowledge graph
- A standard interface so agents choose their own memory tier

---

## Design Principles

1. **Interface-first** — Define `MemoryProvider` once; swap backends without touching agent code
2. **Optional by default** — If no memory config, agents run stateless (workspace context is enough)
3. **Session recall included** — Always document how to find old session logs, even without the memory layer active
4. **Progressive complexity** — Start with Tier 0 (free), upgrade to Tier 3 only when needed
5. **Skill registration as memory** — Learned procedures/patterns are a memory type, not a separate system

---

## Memory Tiers (Lightweight → Heavy)

### Tier 0 — Session Logs Only (current baseline)

```
Cost: Zero    Deps: fs    Latency: <1ms write
```

- Raw JSONL per agent session (already implemented)
- `~/.thronglets/fleet/sessions/{agent}/{date}.jsonl`
- Keyword search via `LocalRecall.search()`
- **No summarization, no cross-session synthesis**

**When to use:** You just want transcripts. Workspace already handles context.

**Finding old sessions:** `ls ~/.thronglets/fleet/sessions/{agent}/` — files sorted by date.
The `index.json` in the store directory lists all sessions with metadata (first/last message,
preview, message count).

---

### Tier 1 — Markdown Memory File (near-zero overhead)

```
Cost: Zero    Deps: fs    Latency: <1ms
```

Inspired by `memory-mcp` (butterflyskies) and `.cursor/rules` patterns. A single
`MEMORY.md` file per agent (or per workspace) that the agent itself reads and appends to.

```
~/.thronglets/fleet/memory/{agent}/MEMORY.md
```

Structure:
```markdown
# Agent Memory — {agent-name}

## Session Index
| Date | Session ID | Summary |
|------|-----------|---------|
| 2026-05-23 | abc123 | Implemented fleet dispatcher routing |

## Learned Patterns
- When user says "publish", run `scripts/publish-dashboard.sh`
- Prefer `pnpm` over `npm` in this workspace

## Skills
### publish-dashboard
- Trigger: user says "publish" or "deploy dashboard"
- Steps: build dashboard → run publish script → report URL

## Facts
- Project uses TypeScript strict mode
- Dashboard is React + Vite, published to Vibespace
```

**Implementation:** Agent reads `MEMORY.md` at session start (inject into context).
At session end, agent appends a summary + any new learned patterns.

**Advantages:**
- Human-readable, git-trackable
- Agent can self-edit (no external service)
- Works offline, zero dependencies

**Prior art:** Cursor `.cursor/rules`, Claude Code `CLAUDE.md`, the "rules file" pattern

---

### Tier 1.5 — Local SQLite + Embeddings (MCP-based)

```
Cost: Zero (local)    Deps: SQLite + local embedding model    Latency: 10-50ms
```

Use a local MCP memory server. The agent connects via MCP protocol and gets
semantic search for free.

**Best options (2026):**

| Project | Key Feature | Complexity |
|---------|------------|------------|
| [memory-mcp-1file](https://github.com/pomazanbohdan/memory-mcp-1file) | Single Rust binary, embedded SurrealDB, no API keys | Lowest |
| [local-memory-mcp](https://github.com/vheins/local-memory-mcp) | SQLite + `all-MiniLM-L6-v2` local embeddings, memory decay | Low |
| [memory-mcp (butterflyskies)](https://github.com/butterflyskies/memory-mcp) | Git-backed markdown, local BERT embeddings, cross-device sync | Medium |
| [mcp-local-context-memory](https://github.com/eldarj/mcp-local-context-memory) | Python + SQLite, custom tools via drop-in scripts | Low |

**Integration approach:**
```yaml
# bridge.yaml
memory:
  provider: mcp
  server: memory-mcp-1file
  config:
    data_dir: ~/.thronglets/fleet/memory
```

The agent calls `memory_store` / `memory_recall` tools via MCP. Thronglets doesn't
need to understand the internals — it just ensures the MCP server is available.

---

### Tier 2 — Mem0 (Managed API, plug-and-play)

```
Cost: API calls    Deps: mem0 SDK    Latency: 100-300ms
```

[Mem0](https://github.com/mem0ai/mem0) is the lightest **cloud** memory layer. Minimal
lock-in — it's a service with a clean API boundary. Your agent framework stays untouched.

**Key features (April 2026 algorithm):**
- Single-pass ADD-only extraction (one LLM call, no agentic loops)
- Entity linking across memories
- Multi-signal retrieval: semantic + BM25 keyword + entity matching (fused)
- Multi-level: User memory, Session memory, Agent memory
- Self-hosted option available

**API surface:**
```typescript
import { MemoryClient } from "mem0ai";

const mem = new MemoryClient({ apiKey: "..." });

// Store
await mem.add("User prefers dark mode and uses pnpm", { user_id: "simon", agent_id: "builder-1" });

// Recall
const memories = await mem.search("what package manager?", { user_id: "simon" });
```

**When to use:** You want cross-session memory with semantic search but don't need
graph relationships or temporal reasoning. Lowest integration cost for cloud memory.

---

### Tier 2.5 — Hindsight (Retain / Recall / Reflect)

```
Cost: API calls    Deps: hindsight SDK    Latency: 200-800ms
```

[Hindsight](https://github.com/vectorize-io/hindsight) (Dec 2025, vectorize.io) is
purpose-built for **self-improving agents**. It goes beyond storage with a `reflect`
operation that synthesizes opinions and observations from accumulated experience.

**Architecture:**
- **Tempr** — Temporal Entity Memory Priming Retrieval (retain + recall)
- **Cara** — Coherent Adaptive Reasoning Agents (reflect)

**Three operations:**

| Op | What it does |
|----|-------------|
| `retain(bank, content, type)` | Ingest facts or experiences into the memory bank |
| `recall(bank, query, max_tokens)` | Multi-strategy retrieval: semantic + BM25 + graph + temporal, fused via RRF, cross-encoder reranked |
| `reflect(bank, query, budget)` | Agentic reasoning loop that searches memory, applies disposition traits, produces synthesized answer + updates opinion network |

**Why this matters for skills:**
- After completing a task, agent calls `retain` with the episode
- Periodically calls `reflect("What patterns have I learned about deployment?")` 
- Reflect produces observations that are themselves stored as opinions
- Next time the agent faces a similar task, `recall` surfaces both facts AND learned opinions

**Memory types:** `world` (facts), `experience` (episodes), `opinion` (synthesized)

**LongMemEval benchmark:** SOTA as of Dec 2025.

```typescript
import { HindsightClient } from "@anthropic/hindsight"; // hypothetical

const hs = new HindsightClient({ apiKey: "..." });
const bankId = "agent-builder-1";

// After completing a task
await hs.retain(bankId, {
  content: "Successfully deployed dashboard using vite build --mode singlefile + vibespace API",
  type: "experience",
  tags: ["deployment", "dashboard"]
});

// Before starting a new task
const context = await hs.recall(bankId, "How to deploy the dashboard?", { max_tokens: 2048 });

// Periodic self-improvement
const insight = await hs.reflect(bankId, "What deployment patterns work best?", { budget: "mid" });
```

---

### Tier 3 — Zep / Graphiti (Temporal Knowledge Graph)

```
Cost: Self-host or managed    Deps: Neo4j + LLM    Latency: 100-500ms
```

[Zep](https://www.getzep.com) / [Graphiti](https://github.com/getzep/graphiti) builds a
**temporal knowledge graph** — facts have validity periods, relationships evolve, and the
graph auto-invalidates stale information.

**When Tier 2-2.5 isn't enough:**
- Agent operates over weeks/months with evolving facts
- Need point-in-time queries ("What did user prefer *last month*?")
- Business data + chat data must fuse into one context
- Multi-user isolation with complex scoping

**Architecture:**
```
Messages/Data → Episode Ingestion → Entity Extraction → KG Update
                                                            ↓
Query → Hybrid Search (semantic + BM25 + graph + temporal) → Context Assembly
```

**Graphiti features:**
- Temporal metadata on all edges (valid_from, valid_to, invalidated_at)
- Episodic processing — maintains provenance
- Community detection for theme clustering
- MCP server available (`graphiti/mcp_server`)
- Self-hosted with Neo4j, or use managed Zep

**Integration:**
```yaml
memory:
  provider: zep
  config:
    api_url: http://localhost:8000
    # or: api_key: zep_xxxxx (managed)
```

---

### Tier 4 — Letta (Full Agent Runtime with Memory OS)

```
Cost: Self-host or managed    Deps: Full Letta server    Latency: 100-500ms
```

[Letta](https://github.com/letta-ai/letta) (formerly MemGPT) treats memory as a
**virtual memory hierarchy** — core memory, recall memory, archival memory — with the
agent actively managing its own context window.

**Key difference:** Letta is not just a memory layer — it's a full agent runtime.
Agents run *inside* Letta, which manages the loop, tools, and state.

**When to consider:**
- Building agents that run for weeks autonomously
- Want agents to self-edit their own core beliefs/instructions
- Need the agent to actively decide what to remember vs archive
- Willing to adopt Letta as your agent platform

**Lock-in warning:** High. Adopting Letta means rewriting your agent infrastructure.
For Thronglets, this is a **complement** not a replacement — you'd run a Letta agent
as one of your fleet runtimes, with Letta managing that agent's memory internally.

---

## Skill Registration System

Skills are a **memory type**, stored in whichever tier you're using. A skill is:

```typescript
interface Skill {
  id: string;
  name: string;              // e.g. "publish-dashboard"
  trigger: string;           // natural language description of when to use
  steps: string[];           // ordered procedure
  source: "learned" | "manual" | "imported";
  confidence: number;        // 0-1, increases with successful use
  lastUsed?: string;         // ISO timestamp
  failCount: number;
  successCount: number;
  tags: string[];
}
```

### Skill Lifecycle

```
1. Discovery   — Agent encounters a novel multi-step task
2. Extraction  — After success, extract steps into a Skill
3. Storage     — Persist in the active memory tier
4. Retrieval   — On similar future task, recall matching skills
5. Execution   — Follow skill steps (with adaptation)
6. Refinement  — On failure, update steps; on repeated failure, deprecate
7. Sharing     — Cross-agent skill export (fleet-level skill library)
```

### Research References

| Paper/Project | Key Idea | Relevance |
|---------------|----------|-----------|
| [SkillMaster](https://arxiv.org/html/2605.08693) (May 2026) | Agent autonomously proposes/updates/retains skills via trajectory review + counterfactual utility | Direct model for our skill refinement loop |
| [Memento-Skills](https://arxiv.org/pdf/2603.18743v1) (Mar 2026) | Executable "skill folders" updated via read-write reflective learning, no weight updates | Validates file-based skill storage approach |
| [SkillX](https://arxiv.org/pdf/2604.04804) (Apr 2026) | Multi-level skills (Planning/Functional/Atomic) + iterative refinement + exploratory expansion | Architecture for skill hierarchy |
| [SkillNet](https://arxiv.org/pdf/2603.04448) (Mar 2026) | Skills as independent units with dependency graph, evaluation dimensions, community sharing | Model for fleet-level skill sharing |

### Implementation for Thronglets

**Tier 0-1 (file-based):** Skills stored as entries in `MEMORY.md` or a `skills/` directory
with one markdown file per skill.

**Tier 1.5+ (structured):** Skills stored as structured data in the memory backend,
queryable by trigger similarity and tags.

**Fleet-level sharing:**
```
~/.thronglets/fleet/skills/         # shared across all agents
~/.thronglets/fleet/skills/{agent}/ # agent-specific overrides
```

---

## MemoryProvider Interface

```typescript
export interface MemoryProvider {
  /** Store a memory entry */
  store(entry: MemoryEntry): Promise<void>;

  /** Recall memories relevant to a query */
  recall(query: string, opts?: RecallOpts): Promise<MemoryEntry[]>;

  /** Store or update a skill */
  registerSkill(skill: Skill): Promise<void>;

  /** Find skills matching a task description */
  findSkills(taskDescription: string, opts?: { limit?: number }): Promise<Skill[]>;

  /** Generate summary/synthesis from accumulated memories (Tier 2.5+) */
  reflect?(query: string, opts?: ReflectOpts): Promise<string>;

  /** List all sessions with metadata */
  listSessions(opts?: { limit?: number; after?: string }): Promise<SessionMeta[]>;

  /** Get full session transcript */
  getSession(sessionId: string): Promise<MemoryEntry[]>;
}

export interface MemoryEntry {
  id: string;
  type: "fact" | "experience" | "opinion" | "skill" | "session";
  content: string;
  tags: string[];
  timestamp: string;
  agentName?: string;
  sessionId?: string;
  confidence?: number;
  expiresAt?: string;
}

export interface RecallOpts {
  maxTokens?: number;
  types?: MemoryEntry["type"][];
  tags?: string[];
  after?: string;
  limit?: number;
}

export interface ReflectOpts {
  budget?: "low" | "mid" | "high";
  tags?: string[];
}
```

---

## Configuration

```yaml
# ~/.thronglets/config.yaml
memory:
  provider: markdown          # "off" | "markdown" | "mcp" | "mem0" | "hindsight" | "zep" | "letta"
  
  # Tier 1
  markdown:
    path: ~/.thronglets/fleet/memory

  # Tier 1.5
  mcp:
    server: memory-mcp-1file
    data_dir: ~/.thronglets/fleet/memory

  # Tier 2
  mem0:
    api_key: ${MEM0_API_KEY}
    # or self_hosted: http://localhost:8080

  # Tier 2.5
  hindsight:
    api_key: ${HINDSIGHT_API_KEY}
    bank_id: thronglets-fleet

  # Tier 3
  zep:
    api_url: http://localhost:8000
    # or api_key for managed

  skills:
    enabled: true
    shared_dir: ~/.thronglets/fleet/skills
    auto_extract: true        # auto-extract skills after successful multi-step tasks
    confidence_threshold: 0.3 # min confidence to suggest a skill
```

---

## Finding Old Session Memory

Regardless of which tier is active, session transcripts are always available:

```bash
# List all sessions for an agent
ls ~/.thronglets/fleet/sessions/{agent-name}/

# Search across sessions (built-in)
thronglets recall "deploy dashboard" --agent builder-1

# View session index (when memory layer is active)
cat ~/.thronglets/fleet/memory/{agent-name}/MEMORY.md  # Tier 1
# or query via API for Tier 2+
```

The `MEMORY.md` Session Index table serves as a human-readable log of what each
session accomplished — even if you switch memory tiers later, this table persists.

---

## Implementation Roadmap

| Step | What | Complexity |
|------|------|-----------|
| 4.5.1 | Define `MemoryProvider` interface + `MemoryEntry`/`Skill` types | Low |
| 4.5.2 | Implement `MarkdownMemoryProvider` (Tier 1) | Low |
| 4.5.3 | Auto-generate session summary at session end, append to MEMORY.md | Medium |
| 4.5.4 | Inject MEMORY.md into agent context at session start | Low |
| 4.5.5 | Skill extraction prompt + `registerSkill` flow | Medium |
| 4.5.6 | MCP memory adapter (delegate to any MCP memory server) | Medium |
| 4.5.7 | Mem0 adapter | Low (SDK wrapper) |
| 4.5.8 | Hindsight adapter with reflect loop | Medium |
| 4.5.9 | Fleet-level skill sharing + confidence tracking | High |
| 4.5.10 | Dashboard: memory/skills viewer | Medium |

---

## Comparison Matrix

| | Tier 0 | Tier 1 | Tier 1.5 | Tier 2 | Tier 2.5 | Tier 3 | Tier 4 |
|---|---|---|---|---|---|---|---|
| **Backend** | JSONL | Markdown | SQLite+MCP | Mem0 API | Hindsight | Zep/Graphiti | Letta |
| **Semantic search** | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Summarization** | ✗ | Manual | ✗ | ✗ | ✓ (reflect) | ✗ | ✓ |
| **Temporal reasoning** | ✗ | ✗ | ✗ | ✗ | ✓ | ✓✓ | ✓ |
| **Skill registration** | ✗ | ✓ (md) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Self-improving** | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| **Offline** | ✓ | ✓ | ✓ | ✗ | ✗ | ✓* | ✓* |
| **Zero deps** | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Lock-in** | None | None | Low | Low | Low | Medium | High |
| **Cost** | Free | Free | Free | $ | $$ | $* | $* |

\* Self-hosted = infrastructure cost only

---

## Recommendation for Thronglets

**Start with Tier 1 (Markdown Memory)** — it's zero-cost, immediately useful, and
human-auditable. Layer on Tier 1.5 (MCP) for semantic search when needed. Design
the `MemoryProvider` interface now so upgrading to Hindsight or Zep later is a
config change, not a rewrite.

The key insight from Hindsight's architecture is that **reflect** (periodic synthesis)
is what separates "memory" from "logs". Even at Tier 1, we can implement a lightweight
reflect: at session end, ask the LLM to summarize what was learned and append to
MEMORY.md. This gives 80% of the value at 0% of the infrastructure cost.
