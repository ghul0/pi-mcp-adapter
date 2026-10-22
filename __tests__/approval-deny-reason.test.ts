import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import {
  MAX_DENY_REASON_BYTES,
  approvalBlockedResult,
  ensureToolCallApproved,
  sanitizeDenyReason,
} from "../tool-approval.ts";
import { startUiServer, type UiServerHandle } from "../ui-server.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { McpServerManager, ServerConnection } from "../server-manager.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalHandler, type McpToolApprovalRequest, type ToolMetadata } from "../types.ts";

const tool: ToolMetadata = { name: "demo_send", originalName: "send", description: "Send" };

function createState(broker: (request: McpToolApprovalRequest) => void) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
  const connection = { status: "connected", client: { callTool }, tools: [{ name: "send", description: "Send" }], resources: [], prompts: [] };
  const state = {
    config: { mcpServers: { demo: { command: "demo" } } },
    toolMetadata: new Map([["demo", [tool]]]),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    approvedToolCalls: new Map<string, true>(),
    approvalEvents: { emit: vi.fn((channel: string, data: unknown) => {
      expect(channel).toBe(MCP_TOOL_APPROVAL_REQUEST_EVENT);
      broker(data as McpToolApprovalRequest);
    }) },
    manager: {
      getConnection: () => connection,
      getRequestOptions: () => undefined,
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    failureMessages: new Map(),
  } as unknown as McpExtensionState;
  return { state, callTool };
}

function claiming(handler: McpToolApprovalHandler) {
  return (request: McpToolApprovalRequest) => { request.claim(handler); };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

describe("broker deny reason", () => {
  it("advertises the capability on every request", async () => {
    let seen: McpToolApprovalRequest | undefined;
    const { state } = createState((request) => { seen = request; request.claim(() => "allow_once"); });
    await executeCall(state, tool.name, {});
    expect(seen?.supportsDenyReason).toBe(true);
  });

  it("puts the reason into the proxy call's own result", async () => {
    const { state, callTool } = createState(claiming(() => ({ decision: "deny", reason: "Nie teraz" })));
    const result = await executeCall(state, tool.name, {});
    expect(text(result)).toBe('MCP tool "send" on server "demo" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.\nReason: Nie teraz');
    expect(result.details).toMatchObject({ mode: "call", error: "approval_denied", server: "demo", tool: "send", reason: "Nie teraz" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("puts the reason into the direct call's own result", async () => {
    const { state, callTool } = createState(claiming(() => ({ decision: "deny", reason: "Zła godzina" })));
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "send", prefixedName: "demo_send", description: "Send",
    });
    const result = await execute("call-1", {}, undefined, undefined, {} as never);
    expect(text(result)).toContain("\nReason: Zła godzina");
    expect(result.details).toMatchObject({ error: "approval_denied", reason: "Zła godzina" });
    expect(callTool).not.toHaveBeenCalled();
  });

  describe("iframe", () => {
    let handle: UiServerHandle | undefined;
    afterEach(async () => { await handle?.close(); handle = undefined; });

    it("puts the reason into the iframe call's own result", async () => {
      const { state } = createState(claiming(() => ({ decision: "deny", reason: "Z okna" })));
      const connection = { status: "connected", client: { callTool: vi.fn() }, tools: [{ name: "send" }] } as unknown as ServerConnection;
      const manager = {
        getConnection: vi.fn(() => connection), touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
        getRequestOptions: vi.fn(() => undefined),
      } as unknown as McpServerManager;
      handle = await startUiServer({
        serverName: "demo", toolName: "send", toolArgs: {},
        resource: { uri: "ui://demo/w", html: "<p>x</p>", mimeType: "text/html", meta: { permissions: [] } },
        manager, config: state.config, state,
        consentManager: { requiresPrompt: vi.fn().mockReturnValue(false), shouldCacheConsent: vi.fn().mockReturnValue(true),
          ensureApproved: vi.fn(), registerDecision: vi.fn() } as unknown as ConsentManager,
      });
      const body = await new Promise<any>((resolve, reject) => {
        const req = http.request({ hostname: "localhost", port: handle!.port, path: "/proxy/tools/call", method: "POST",
          headers: { "Content-Type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ token: handle!.sessionToken, params: { name: "send", arguments: {} } }));
      });
      expect(body.result.content[0].text).toContain("\nReason: Z okna");
      expect(body.result.details).toMatchObject({ error: "approval_denied", reason: "Z okna" });
      expect(connection.client.callTool).not.toHaveBeenCalled();
    });
  });

  it("keeps each concurrent call's reason with that call, resolved out of order", async () => {
    const pending: Array<(value: { decision: "deny"; reason: string }) => void> = [];
    const { state } = createState(claiming(() => new Promise((resolve) => { pending.push(resolve); })));
    const first = executeCall(state, tool.name, { n: 1 });
    const second = executeCall(state, tool.name, { n: 2 });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ decision: "deny", reason: "powód drugi" });
    pending[0]!({ decision: "deny", reason: "powód pierwszy" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.details).toMatchObject({ reason: "powód pierwszy" });
    expect(b.details).toMatchObject({ reason: "powód drugi" });
  });

  it("leaves legacy string decisions exactly as before", async () => {
    for (const [decision, expected] of [
      ["allow_once", { ok: true }],
      ["allow_for_session", { ok: true }],
      ["deny", { ok: false, reason: "denied" }],
    ] as const) {
      const { state } = createState(claiming(() => decision));
      await expect(ensureToolCallApproved(state, "demo", tool, {})).resolves.toEqual(expected);
    }
    const { state } = createState(claiming(() => "deny"));
    const result = await executeCall(state, tool.name, {});
    expect(text(result)).toBe('MCP tool "send" on server "demo" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.');
    expect(result.details).not.toHaveProperty("reason");
  });

  it("treats every malformed object as a plain deny", async () => {
    for (const bad of [
      { decision: "allow_once", reason: "x" },
      { decision: "allow_for_session" },
      { decision: "deny" },
      { decision: "deny", reason: 42 },
      { decision: "deny", reason: "   " },
      { reason: "no decision" },
      "maybe",
      null,
    ]) {
      const { state } = createState(claiming(() => bad as never));
      await expect(ensureToolCallApproved(state, "demo", tool, {})).resolves.toEqual({ ok: false, reason: "denied" });
    }
  });

  it("still throws on abort and still denies without a reason when the handler throws", async () => {
    const controller = new AbortController();
    const { state } = createState(claiming(() => new Promise(() => {})));
    const waiting = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(new Error("aborted"));
    await expect(waiting).rejects.toThrow();

    const failing = createState(claiming(() => { throw new Error("broker down"); }));
    await expect(ensureToolCallApproved(failing.state, "demo", tool, {})).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("abstains to the adapter's own policy when nobody claims", async () => {
    const { state, callTool } = createState(() => {});
    await executeCall(state, tool.name, {});
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe("sanitizeDenyReason", () => {
  it("keeps Polish letters, newlines and tabs; drops escapes and control characters", () => {
    const raw = "Zażółć\tgęślą\r\njaźń\x1b[31m czerwony\x1b[0m\x1b]8;;http://evil\x07link\x1b]8;;\x07\x00\x08\x7f";
    expect(sanitizeDenyReason(raw)).toBe("Zażółć\tgęślą\njaźń czerwonylink");
  });

  it("keeps a reason up to the limit whole", () => {
    const reason = "ż".repeat(MAX_DENY_REASON_BYTES / 2);
    expect(sanitizeDenyReason(reason)).toBe(reason);
  });

  it("cuts an over-long reason on a character boundary and marks it", () => {
    const result = sanitizeDenyReason("ż".repeat(MAX_DENY_REASON_BYTES))!;
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_DENY_REASON_BYTES);
    expect(result.endsWith("\n[… reason truncated]")).toBe(true);
    expect(result).not.toContain("�");
  });

  it("returns undefined for a reason that is empty after cleaning", () => {
    expect(sanitizeDenyReason("\x1b[0m \n\t")).toBeUndefined();
  });

  it("formats the headless gate unchanged", () => {
    expect(approvalBlockedResult({ ok: false, reason: "approval_required_headless" }, "demo", "send")).toEqual({
      text: 'MCP tool "send" on server "demo" is approval-gated and requires an interactive session.',
      details: { error: "approval_required", server: "demo", tool: "send" },
    });
  });
});
