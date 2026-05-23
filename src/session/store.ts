import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { LocalRecall, type RecallEntry } from "../recall/local.js";
import type { RecallMode } from "../config.js";

export interface LogEntry {
  ts: string;
  sessionId: string;
  chatId: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
}

export interface CloudRecallConfig {
  apiUrl: string;
  apiKey: string;
  workspaceId?: string;
  workspacePath?: string;
}

export interface StoreConfig {
  logDir: string;
  storeDir: string;
  recallMode: RecallMode;
  cloud?: CloudRecallConfig;
}

export class SessionStore {
  private logDir: string;
  private localRecall: LocalRecall;
  private cloud: CloudRecallConfig | null;
  private recallMode: RecallMode;

  constructor(config: StoreConfig) {
    this.logDir = config.logDir;
    this.localRecall = new LocalRecall(config.storeDir);
    this.cloud = config.cloud || null;
    this.recallMode = config.recallMode;
    if (!existsSync(config.logDir)) mkdirSync(config.logDir, { recursive: true });
  }

  log(entry: Omit<LogEntry, "ts">): void {
    const full: LogEntry = { ts: new Date().toISOString(), ...entry };

    // Legacy date-based log file
    const date = full.ts.split("T")[0];
    const file = join(this.logDir, `${date}.jsonl`);
    appendFileSync(file, JSON.stringify(full) + "\n");

    // Local recall (per-session structured store)
    if (this.recallMode === "local" || this.recallMode === "both") {
      const recallEntry: RecallEntry = {
        ts: full.ts,
        sessionId: full.sessionId,
        chatId: full.chatId,
        role: full.role,
        content: full.content,
      };
      this.localRecall.log(recallEntry);
    }
  }

  async sync(sessionId: string, role: "user" | "assistant", content: string): Promise<void> {
    if (this.recallMode === "off" || this.recallMode === "local") return;
    if (!this.cloud) return;

    const eventType = role === "user" ? "chat_message_user" : "chat_message_assistant";

    try {
      const url = this.cloud.apiUrl.endsWith("/ingest")
        ? this.cloud.apiUrl
        : `${this.cloud.apiUrl}/api/sync/ingest`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.cloud.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: [{
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            event_type: eventType,
            platform: "thronglets",
            workspace_id: this.cloud.workspaceId || "thronglets",
            workspace_path: this.cloud.workspacePath || "",
            content,
          }],
        }),
      });

      if (!res.ok) {
        console.error(`[store] cloud recall sync failed (${res.status})`);
      }
    } catch (err) {
      console.error(`[store] cloud recall sync error:`, err);
    }
  }

  getLocalRecall(): LocalRecall {
    return this.localRecall;
  }
}
