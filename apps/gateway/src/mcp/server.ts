/**
 * MCP server factory — SDD v0.5 §9 (2026-07-28 modern/stateless profile),
 * §15 (tool surface). A fresh McpServer instance serves each HTTP request;
 * application state lives entirely in explicit handles (§14, NFR-08).
 */
import { McpServer } from '@modelcontextprotocol/server';
import {
  BridgeError,
  DASHBOARD_TOOL_CATALOG,
  DashboardFeedInput,
  DashboardUpsertInput,
  dashboardScopeSatisfies,
  requiredDashboardScope,
  RUN_TOOL_CATALOG,
  RunCheckpointInput,
  RunResumeInput,
  runToolDashboardAction,
  scopeSatisfies,
  TOOL_CATALOG,
  type DashboardToolCatalogEntry,
  type DashboardId,
  type DashboardToolAction,
  type RunToolCatalogEntry,
  type ToolCatalogEntry,
} from '@browser-bridge/protocol';
import type { CommandBroker } from '../broker.js';
import type { DashboardClient } from '../dashboards/client.js';
import type { RunCheckpointService } from '../runs/checkpoints.js';

export interface McpFactoryDeps {
  broker: CommandBroker;
  serverVersion: string;
  /** Present only when the deployment configures the dashboard write-path. */
  dashboards?: DashboardClient | null;
  /** Run bookkeeping for the deals.* tools; registered with the dashboards. */
  runs?: RunCheckpointService | null;
}

interface ToolResultShape {
  [key: string]: unknown;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function errorResult(err: BridgeError): ToolResultShape {
  const payload = err.toPayload();
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: payload }) }],
    isError: true,
  };
}

export function buildMcpServer(deps: McpFactoryDeps, authInfo: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } | undefined): McpServer {
  const server = new McpServer({ name: 'browser-bridge', version: deps.serverVersion });

  for (const entry of TOOL_CATALOG) {
    registerBridgeTool(server, deps, entry, authInfo);
  }
  if (deps.dashboards !== undefined && deps.dashboards !== null) {
    for (const entry of DASHBOARD_TOOL_CATALOG) {
      registerDashboardTool(server, deps.dashboards, entry, authInfo);
    }
  }
  if (deps.runs !== undefined && deps.runs !== null) {
    for (const entry of RUN_TOOL_CATALOG) {
      registerRunTool(server, deps.runs, entry, authInfo);
    }
  }
  return server;
}

/**
 * `deals.*` run bookkeeping. Gateway-served like the dashboard tools, and
 * authorised through the same scope machinery: the catalog entry names the
 * dashboard, runToolDashboardAction maps checkpoint→upsert and
 * resume→feed, and dashboardScopeSatisfies stays the only place the rule
 * lives (§10.2 — Phase 4 introduces no new scope).
 */
function registerRunTool(
  server: McpServer,
  runs: RunCheckpointService,
  entry: RunToolCatalogEntry,
  authInfo: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } | undefined,
): void {
  const scopeAction = runToolDashboardAction(entry.action);
  const handler = async (args: Record<string, unknown>): Promise<ToolResultShape> => {
    try {
      assertDashboardScope(authInfo, entry.dashboard, scopeAction);
      // A run belongs to the OAuth subject that wrote it, so one caller can
      // never resume another's run. Falls back to clientId, and to null
      // when OAuth is disabled — the same identity ladder the broker uses.
      const subject =
        typeof authInfo?.extra?.subject === 'string'
          ? (authInfo.extra.subject as string)
          : (authInfo?.clientId ?? null);
      const structured =
        entry.action === 'checkpoint'
          ? await runs.checkpoint(RunCheckpointInput.parse(args), subject)
          : await runs.resume(RunResumeInput.parse(args).runId, subject);
      const payload = structured as unknown as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } catch (err) {
      return errorResult(BridgeError.from(err));
    }
  };
  server.registerTool(
    entry.name,
    {
      description: `${entry.description} Requires scope ${requiredDashboardScope(entry.dashboard, scopeAction)}${
        scopeAction === 'feed' ? ' or any dashboard write scope' : ''
      }.`,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: {
        readOnlyHint: entry.action === 'resume',
        // A checkpoint only ever replaces its own run row; it writes no
        // listing, touches no dashboard, and drives no browser.
        destructiveHint: false,
        idempotentHint: entry.action === 'resume',
        openWorldHint: false,
      },
    } as never,
    handler as never,
  );
}

function registerDashboardTool(
  server: McpServer,
  client: DashboardClient,
  entry: DashboardToolCatalogEntry,
  authInfo: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } | undefined,
): void {
  const handler = async (args: Record<string, unknown>): Promise<ToolResultShape> => {
    try {
      // Re-parse defensively; unlike browser tools there is no agent-side
      // schema validation behind these.
      const structured =
        entry.action === 'feed'
          ? await (async () => {
              const input = DashboardFeedInput.parse(args);
              assertDashboardScope(authInfo, input.dashboard, entry.action);
              return client.feed(input.dashboard, input.mode, {
                filter: input.filter,
                fields: input.fields,
              });
            })()
          : await (async () => {
              const input = DashboardUpsertInput.parse(args);
              assertDashboardScope(authInfo, input.dashboard, entry.action);
              return client.upsert(input.dashboard, input.listings ?? [], input.touch ?? []);
            })();
      const payload = structured as unknown as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } catch (err) {
      return errorResult(BridgeError.from(err));
    }
  };
  server.registerTool(
    entry.name,
    {
      description: `${entry.description} Requires scope ${
        entry.action === 'upsert' ? '{dashboard}:write (e.g. deals:write)' : 'dashboards:read or any dashboard write scope'
      }.`,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: {
        readOnlyHint: entry.action === 'feed',
        destructiveHint: false,
        idempotentHint: entry.action === 'feed',
        openWorldHint: true,
      },
    } as never,
    handler as never,
  );
}

function assertDashboardScope(
  authInfo: { scopes: string[] } | undefined,
  dashboard: DashboardId,
  action: DashboardToolAction,
): void {
  const scopes = authInfo?.scopes ?? [];
  if (!dashboardScopeSatisfies(scopes, dashboard, action)) {
    throw new BridgeError('ACTION_BLOCKED', `Token lacks required scope ${requiredDashboardScope(dashboard, action)}.`, {
      requiredScope: requiredDashboardScope(dashboard, action),
      dashboard,
    });
  }
}

function registerBridgeTool(
  server: McpServer,
  deps: McpFactoryDeps,
  entry: ToolCatalogEntry,
  authInfo: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } | undefined,
): void {
  // Catalog schemas are Zod v4 strict objects built in @browser-bridge/protocol
  // (which must stay SDK-independent). The SDK's registerTool generics cannot
  // express that cross-package shape, so config and callback are bridged with
  // casts; runtime validation is unaffected and covered by contract tests.
  const handler = async (args: Record<string, unknown>): Promise<ToolResultShape> => {
      // Defense-in-depth: scope re-check at the tool layer; the HTTP
      // boundary enforces the same rule before routing (§10.2, §27.2).
      const scopes = authInfo?.scopes ?? [];
      if (!scopeSatisfies(scopes, entry.scope)) {
        return errorResult(
          new BridgeError('ACTION_BLOCKED', `Token lacks required scope ${entry.scope}.`, {
            requiredScope: entry.scope,
          }),
        );
      }
      const traceparent =
        typeof authInfo?.extra?.traceparent === 'string' ? (authInfo.extra.traceparent as string) : null;
      const subject =
        typeof authInfo?.extra?.subject === 'string' ? (authInfo.extra.subject as string) : authInfo?.clientId ?? null;
      try {
        const outcome = await deps.broker.call(entry.name, args, { subject, traceparent });
        const content: ToolResultShape['content'] = [];
        for (const artifact of outcome.artifacts) {
          if (artifact.inlineBase64 !== null) {
            content.push({ type: 'image', data: artifact.inlineBase64, mimeType: artifact.mimeType });
          } else if (artifact.signedUrl !== null) {
            content.push({
              type: 'text',
              text: `Artifact ${artifact.descriptor.artifactId} (${artifact.mimeType}, ${artifact.descriptor.byteLength} bytes) available until ${artifact.descriptor.expiresAt}: ${artifact.signedUrl}`,
            });
          }
        }
        const structured = shapeStructuredContent(entry.name, outcome.structured, outcome.artifacts);
        content.push({ type: 'text', text: JSON.stringify(structured) });
        return { content, structuredContent: structured };
      } catch (err) {
        return errorResult(BridgeError.from(err));
      }
  };
  server.registerTool(
    entry.name,
    {
      description: `${entry.description} Requires scope ${entry.scope}; policy class ${entry.policyClass}.`,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: {
        readOnlyHint: entry.policyClass === 'read',
        destructiveHint: false,
        idempotentHint: entry.policyClass === 'read',
        openWorldHint: true,
      },
    } as never,
    handler as never,
  );
}

/**
 * Merge broker artifacts into the structuredContent shapes required by
 * Appendix A (artifact descriptor fields).
 */
function shapeStructuredContent(
  toolName: string,
  structured: Record<string, unknown>,
  artifacts: Array<{ descriptor: Record<string, unknown> }>,
): Record<string, unknown> {
  if ((toolName === 'browser.screenshot' || toolName === 'browser.image_get') && artifacts.length > 0) {
    const { artifactId: _drop, ...rest } = structured;
    return { ...rest, artifact: artifacts[0]!.descriptor };
  }
  return structured;
}
