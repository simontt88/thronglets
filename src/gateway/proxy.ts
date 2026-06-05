import express, { Request, Response } from "express";
import type { FleetEventBus } from "../fleet/manager.js";

export interface ToolCall {
  id: string;
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export class AnthropicGateway {
  private apiKey: string;
  private apiBaseUrl = "https://api.anthropic.com";
  private anthropicVersion = "2023-06-01";
  private bus: FleetEventBus;
  private agentName: string;
  private sessionId: string;

  constructor(apiKey: string, bus: FleetEventBus, agentName: string, sessionId: string = "gateway") {
    this.apiKey = apiKey;
    this.bus = bus;
    this.agentName = agentName;
    this.sessionId = sessionId;
  }

  /**
   * Parse messages for tool_use content blocks and emit events
   */
  private parseToolUses(content: unknown[]): ToolCall[] {
    if (!Array.isArray(content)) return [];

    const toolCalls: ToolCall[] = [];
    const timestamp = new Date().toISOString();

    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && b.id && b.name && b.input) {
          const call: ToolCall = {
            id: String(b.id),
            type: "tool_use",
            name: String(b.name),
            input: b.input as Record<string, unknown>,
            timestamp,
          };
          toolCalls.push(call);
          this.emitToolCall(call);
        }
      }
    }

    return toolCalls;
  }

  private emitToolCall(call: ToolCall): void {
    // Emit to fleet event bus for dashboard consumption
    const summary = this.summarizeToolCall(call);
    this.bus.publish("tool_call", this.agentName, this.sessionId, {
      toolName: call.name,
      toolId: call.id,
      summary,
      input: call.input,
    });

    console.log(`[gateway] ${this.agentName} tool_use: ${call.name} (${call.id.slice(0, 8)}) | ${summary}`);
  }

  private summarizeToolCall(call: ToolCall): string {
    const input = call.input as Record<string, unknown>;

    switch (call.name) {
      case "read_file":
        return `📖 ${input.path || "?"}`;
      case "write_file":
        return `✏️ ${input.path || "?"}`;
      case "str_replace_based_edit_tool":
        return `✏️ replace in ${input.file_path || "?"}`;
      case "bash":
        return `▶️ ${String(input.command || "").split(" ")[0]}`;
      case "grep":
        return `🔍 grep ${input.pattern || "?"}`;
      default:
        return `🔧 ${call.name}`;
    }
  }

  /**
   * Handle incoming API requests and proxy to Anthropic
   */
  async handle(req: Request, res: Response): Promise<void> {
    const path = req.path.replace(/^\/v1/, ""); // Strip /v1 prefix if present
    const url = `${this.apiBaseUrl}/v1${path}`;

    try {
      // Build headers for upstream
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
        // Pass through some headers if present
        ...(req.get("anthropic-beta") && { "anthropic-beta": req.get("anthropic-beta")! }),
      };

      // Forward to Anthropic
      const upstreamRes = await fetch(url, {
        method: req.method,
        headers,
        body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
      });

      const responseData = await upstreamRes.json();

      // If this is a message response, parse tool uses
      if (req.path === "/messages" && req.method === "POST") {
        const content = responseData.content as unknown[];
        if (Array.isArray(content)) {
          this.parseToolUses(content);
        }
      }

      // Return response to agent
      res.status(upstreamRes.status).json(responseData);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] proxy error for ${this.agentName}: ${errMsg}`);
      res.status(502).json({
        type: "error",
        error: {
          type: "gateway_error",
          message: `Gateway proxy failed: ${errMsg}`,
        },
      });
    }
  }
}

/**
 * Extract agent name from request body (messages[0].content might have a marker)
 * Format: "[GATEWAY_AGENT:agentname|sessionid]" at start of content
 */
function extractAgentFromRequest(body: Record<string, unknown>): { agentName: string; sessionId: string } {
  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { agentName: "unknown", sessionId: "unknown" };
  }

  const firstMsg = messages[0];
  if (typeof firstMsg.content === "string") {
    const match = firstMsg.content.match(/^\[GATEWAY_AGENT:([^|]+)\|([^\]]+)\]/);
    if (match) {
      return { agentName: match[1], sessionId: match[2] };
    }
  } else if (Array.isArray(firstMsg.content)) {
    const block = (firstMsg.content as Array<{ type?: string; text?: string }>).find((b) => b.type === "text");
    if (block?.text?.match(/^\[GATEWAY_AGENT:/)) {
      const match = block.text.match(/^\[GATEWAY_AGENT:([^|]+)\|([^\]]+)\]/);
      if (match) {
        return { agentName: match[1], sessionId: match[2] };
      }
    }
  }

  return { agentName: "unknown", sessionId: "unknown" };
}

/**
 * Create a gateway router that handles multiple agents
 */
export function createGatewayRouter(bus: FleetEventBus, apiKey: string): express.Router {
  const router = express.Router();
  const gateways = new Map<string, AnthropicGateway>();

  // Proxy all requests
  router.all("*", async (req, res) => {
    const { agentName, sessionId } = extractAgentFromRequest(req.body as Record<string, unknown>);

    if (!gateways.has(agentName)) {
      gateways.set(agentName, new AnthropicGateway(apiKey, bus, agentName, sessionId));
    }

    const gateway = gateways.get(agentName)!;
    await gateway.handle(req, res);
  });

  return router;
}
