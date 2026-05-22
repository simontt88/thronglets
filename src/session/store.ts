import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface LogEntry {
  ts: string;
  sessionId: string;
  chatId: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
}

export interface RecallConfig {
  apiUrl: string;
  apiKey: string;
  workspaceId?: string;
  workspacePath?: string;
}

export class SessionStore {
  private logDir: string;
  private recall: RecallConfig | null;

  constructor(logDir: string, recall?: RecallConfig) {
    this.logDir = logDir;
    this.recall = recall || null;
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }

  log(entry: Omit<LogEntry, "ts">): void {
    const full: LogEntry = { ts: new Date().toISOString(), ...entry };
    const date = full.ts.split("T")[0];
    const file = join(this.logDir, `${date}.jsonl`);
    appendFileSync(file, JSON.stringify(full) + "\n");
  }

  async sync(sessionId: string, role: "user" | "assistant", content: string): Promise<void> {
    if (!this.recall) return;

    const eventType = role === "user" ? "chat_message_user" : "chat_message_assistant";

    try {
      const url = this.recall.apiUrl.endsWith("/ingest")
        ? this.recall.apiUrl
        : `${this.recall.apiUrl}/api/sync/ingest`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.recall.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: [{
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            event_type: eventType,
            platform: "agent-bridge",
            workspace_id: this.recall.workspaceId || "agent-bridge",
            workspace_path: this.recall.workspacePath || "",
            content,
          }],
        }),
      });

      if (!res.ok) {
        console.error(`[store] recall sync failed (${res.status})`);
      }
    } catch (err) {
      console.error(`[store] recall sync error:`, err);
    }
  }
}
