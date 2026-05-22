import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync,
} from "fs";
import { join } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";

export interface RecallEntry {
  ts: string;
  sessionId: string;
  chatId: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
}

export interface SessionMeta {
  id: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  preview: string;
}

export interface RecallResult {
  entry: RecallEntry;
  sessionId: string;
  score: number;
}

export class LocalRecall {
  private sessionsDir: string;
  private indexPath: string;

  constructor(storeDir: string) {
    this.sessionsDir = join(storeDir, "sessions");
    this.indexPath = join(storeDir, "index.json");
    if (!existsSync(this.sessionsDir)) mkdirSync(this.sessionsDir, { recursive: true });
  }

  log(entry: RecallEntry): void {
    const file = join(this.sessionsDir, `${entry.sessionId}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + "\n");
    this.updateIndex(entry);
  }

  private updateIndex(entry: RecallEntry): void {
    const index = this.loadIndex();
    const existing = index[entry.sessionId];

    if (existing) {
      existing.lastMessage = entry.ts;
      if (entry.role === "user" || entry.role === "assistant") {
        existing.messageCount++;
      }
      if (!existing.preview && entry.role === "user") {
        existing.preview = entry.content.slice(0, 120);
      }
    } else {
      index[entry.sessionId] = {
        id: entry.sessionId,
        firstMessage: entry.ts,
        lastMessage: entry.ts,
        messageCount: 1,
        preview: entry.role === "user" ? entry.content.slice(0, 120) : "",
      };
    }

    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }

  private loadIndex(): Record<string, SessionMeta> {
    if (!existsSync(this.indexPath)) return {};
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf-8"));
    } catch {
      return {};
    }
  }

  listSessions(opts?: { limit?: number; after?: string }): SessionMeta[] {
    const index = this.loadIndex();
    let sessions = Object.values(index);

    if (opts?.after) {
      sessions = sessions.filter((s) => s.lastMessage >= opts.after!);
    }

    sessions.sort((a, b) => b.lastMessage.localeCompare(a.lastMessage));

    if (opts?.limit) {
      sessions = sessions.slice(0, opts.limit);
    }

    return sessions;
  }

  async search(query: string, opts?: { after?: string; limit?: number; sessionId?: string }): Promise<RecallResult[]> {
    const limit = opts?.limit || 20;
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    const files = this.getSessionFiles(opts?.sessionId, opts?.after);
    const results: RecallResult[] = [];

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      await this.searchFile(join(this.sessionsDir, file), sessionId, tokens, results);
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private getSessionFiles(sessionId?: string, after?: string): string[] {
    if (sessionId) {
      const f = `${sessionId}.jsonl`;
      return existsSync(join(this.sessionsDir, f)) ? [f] : [];
    }

    let files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));

    if (after) {
      const index = this.loadIndex();
      files = files.filter((f) => {
        const id = f.replace(".jsonl", "");
        const meta = index[id];
        return meta ? meta.lastMessage >= after : true;
      });
    }

    return files;
  }

  private async searchFile(
    path: string,
    sessionId: string,
    tokens: string[],
    results: RecallResult[],
  ): Promise<void> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

      rl.on("line", (line) => {
        try {
          const entry = JSON.parse(line) as RecallEntry;
          if (entry.role !== "user" && entry.role !== "assistant") return;

          const lower = entry.content.toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (lower.includes(t)) score++;
          }
          if (score > 0) {
            results.push({ entry, sessionId, score: score / tokens.length });
          }
        } catch {
          // skip malformed lines
        }
      });

      rl.on("close", resolve);
      rl.on("error", resolve);
    });
  }
}
