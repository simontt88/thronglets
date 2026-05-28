import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import { randomBytes } from "crypto";

const BINDINGS_FILE = join(GLOBAL_CONFIG_DIR, "chat-bindings.json");

export type ChatRole = "owner" | "external";

export interface ExternalPermissions {
  canChat: boolean;
  canViewFiles: boolean;
  canRequestEdit: boolean;
  canSpawn: boolean;
  canSeeFleet: boolean;
  maxMessagesPerHour: number;
}

export interface ChatBinding {
  chatId: string;
  role: ChatRole;
  boundAgent?: string;
  permissions: ExternalPermissions;
  label?: string;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
}

export interface InviteToken {
  token: string;
  agent: string;
  permissions: ExternalPermissions;
  label?: string;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
  used: boolean;
}

interface BindingsState {
  bindings: Record<string, ChatBinding>;
  invites: Record<string, InviteToken>;
  version: number;
  lastUpdated: string;
}

export const PERMISSION_PRESETS: Record<string, ExternalPermissions> = {
  readonly: {
    canChat: true,
    canViewFiles: true,
    canRequestEdit: false,
    canSpawn: false,
    canSeeFleet: false,
    maxMessagesPerHour: 30,
  },
  interactive: {
    canChat: true,
    canViewFiles: true,
    canRequestEdit: true,
    canSpawn: false,
    canSeeFleet: false,
    maxMessagesPerHour: 60,
  },
  demo: {
    canChat: true,
    canViewFiles: false,
    canRequestEdit: false,
    canSpawn: false,
    canSeeFleet: false,
    maxMessagesPerHour: 10,
  },
};

export class ChatBindingsManager {
  private state: BindingsState;

  constructor() {
    this.state = this.load();
  }

  private load(): BindingsState {
    if (!existsSync(BINDINGS_FILE)) {
      return { bindings: {}, invites: {}, version: 1, lastUpdated: new Date().toISOString() };
    }
    try {
      return JSON.parse(readFileSync(BINDINGS_FILE, "utf-8")) as BindingsState;
    } catch {
      return { bindings: {}, invites: {}, version: 1, lastUpdated: new Date().toISOString() };
    }
  }

  private save(): void {
    const dir = join(GLOBAL_CONFIG_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(BINDINGS_FILE)) {
      try { copyFileSync(BINDINGS_FILE, BINDINGS_FILE + ".bak"); } catch {}
    }

    this.state.lastUpdated = new Date().toISOString();
    const tmp = BINDINGS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    const { renameSync } = require("fs");
    renameSync(tmp, BINDINGS_FILE);
  }

  getBinding(chatId: string): ChatBinding | null {
    const binding = this.state.bindings[chatId];
    if (!binding) return null;
    if (binding.expiresAt && new Date(binding.expiresAt) < new Date()) {
      delete this.state.bindings[chatId];
      this.save();
      return null;
    }
    return binding;
  }

  isExternalChat(chatId: string): boolean {
    const binding = this.getBinding(chatId);
    return binding?.role === "external";
  }

  getBoundAgent(chatId: string): string | null {
    const binding = this.getBinding(chatId);
    return binding?.boundAgent || null;
  }

  getPermissions(chatId: string): ExternalPermissions | null {
    const binding = this.getBinding(chatId);
    return binding?.permissions || null;
  }

  share(agentName: string, chatId: string, createdBy: string, preset: string = "readonly", label?: string): string {
    const permissions = PERMISSION_PRESETS[preset];
    if (!permissions) {
      return `Unknown preset "${preset}". Available: ${Object.keys(PERMISSION_PRESETS).join(", ")}`;
    }

    this.state.bindings[chatId] = {
      chatId,
      role: "external",
      boundAgent: agentName,
      permissions,
      label,
      createdAt: new Date().toISOString(),
      createdBy,
    };
    this.save();
    return `Shared @${agentName} with chat ${chatId} (${preset})`;
  }

  unshare(chatId: string): string {
    const binding = this.state.bindings[chatId];
    if (!binding || binding.role !== "external") {
      return `No external binding found for chat ${chatId}`;
    }
    const agentName = binding.boundAgent;
    delete this.state.bindings[chatId];
    this.save();
    return `Unshared @${agentName} from chat ${chatId}`;
  }

  unshareAgent(agentName: string): number {
    let count = 0;
    for (const [chatId, binding] of Object.entries(this.state.bindings)) {
      if (binding.boundAgent === agentName && binding.role === "external") {
        delete this.state.bindings[chatId];
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  createInvite(agentName: string, createdBy: string, preset: string = "readonly", label?: string, expiresInHours?: number): InviteToken {
    const permissions = PERMISSION_PRESETS[preset] || PERMISSION_PRESETS.readonly;
    const token = `${agentName.toLowerCase()}_${randomBytes(8).toString("hex")}`;

    const invite: InviteToken = {
      token,
      agent: agentName,
      permissions,
      label,
      createdAt: new Date().toISOString(),
      createdBy,
      expiresAt: expiresInHours
        ? new Date(Date.now() + expiresInHours * 3600_000).toISOString()
        : undefined,
      used: false,
    };

    this.state.invites[token] = invite;
    this.save();
    return invite;
  }

  redeemInvite(token: string, chatId: string): { success: boolean; message: string; agent?: string } {
    const invite = this.state.invites[token];
    if (!invite) return { success: false, message: "Invalid invite token." };
    if (invite.used) return { success: false, message: "This invite has already been used." };
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return { success: false, message: "This invite has expired." };
    }

    const existing = this.state.bindings[chatId];
    if (existing?.role === "external") {
      return { success: false, message: `This chat is already connected to @${existing.boundAgent}.` };
    }

    this.state.bindings[chatId] = {
      chatId,
      role: "external",
      boundAgent: invite.agent,
      permissions: invite.permissions,
      label: invite.label,
      createdAt: new Date().toISOString(),
      createdBy: invite.createdBy,
      expiresAt: invite.expiresAt,
    };

    invite.used = true;
    this.save();
    return { success: true, message: `Connected to @${invite.agent}!`, agent: invite.agent };
  }

  listExternalBindings(): ChatBinding[] {
    return Object.values(this.state.bindings)
      .filter(b => b.role === "external")
      .filter(b => !b.expiresAt || new Date(b.expiresAt) >= new Date());
  }

  listActiveInvites(): InviteToken[] {
    return Object.values(this.state.invites)
      .filter(i => !i.used)
      .filter(i => !i.expiresAt || new Date(i.expiresAt) >= new Date());
  }
}
