/**
 * The ebay_api_* MCP tools — docs/COUNTDOWN-API-PLAN.md §3 and §6.5.
 *
 * Gateway-served like the dashboard tools, following registerDashboardTool
 * in ../mcp/server.ts: screen every url in the input, parse it defensively,
 * assert browser:read, run the CountdownSource handler inside the entry's
 * catalog deadline, validate the payload against the catalogued output
 * schema, and answer with content plus structuredContent. Every failure
 * becomes an error result carrying a BridgeError payload.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import {
  BridgeError,
  EbayApiItemsInput,
  EbayApiSearchInput,
  EbayApiSellerInput,
  SCOPE_READ,
  SOURCE_TOOL_CATALOG,
  scopeSatisfies,
  screenEbayUrl,
  type EbayUrlKind,
  type SourceToolCatalogEntry,
} from '@browser-bridge/protocol';
import {
  ITEMS_TOOL_NAME,
  SEARCH_TOOL_NAME,
  SELLER_TOOL_NAME,
  type CountdownSource,
  type SourceCaller,
  type SourceDeadline,
} from './source.js';

/** The slice of the SDK's AuthInfo the source tools read. */
export interface SourceAuthInfo {
  scopes: string[];
  clientId: string;
  extra?: Record<string, unknown>;
}

/** Registration knobs; only tests set any of them. */
export interface SourceToolRegistrationOptions {
  /** Replaces every entry's catalog timeoutMs, so a deadline test does not have to wait two minutes. */
  timeoutMs?: number;
}

interface ToolResultShape {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface InputIssue {
  path: PropertyKey[];
  message: string;
}

/** Same shape ../mcp/server.ts answers with; kept local so this module never imports the factory that imports it. */
function errorResult(err: BridgeError): ToolResultShape {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: err.toPayload() }) }],
    isError: true,
  };
}

export function registerSourceTools(
  server: McpServer,
  source: CountdownSource,
  authInfo: SourceAuthInfo | undefined,
  options: SourceToolRegistrationOptions = {},
): void {
  for (const entry of SOURCE_TOOL_CATALOG) {
    registerSourceTool(server, source, entry, authInfo, options.timeoutMs ?? entry.timeoutMs);
  }
}

function registerSourceTool(
  server: McpServer,
  source: CountdownSource,
  entry: SourceToolCatalogEntry,
  authInfo: SourceAuthInfo | undefined,
  deadlineMs: number,
): void {
  const handler = async (args: Record<string, unknown>): Promise<ToolResultShape> => {
    try {
      // Defense-in-depth: the SDK validated the input already and the HTTP
      // boundary only screens browser tools, so the scope rule is enforced
      // here, exactly as the dashboard tools do it.
      assertReadScope(authInfo, entry);
      const payload = await withDeadline(deadlineMs, (deadline) => runSourceTool(source, entry.name, args, callerOf(authInfo), deadline));
      const checked = entry.outputSchema.safeParse(payload);
      if (!checked.success) {
        // A payload that drifts from the contract is a gateway bug, and the
        // caller must see that rather than a silently wrong shape.
        throw new BridgeError('INTERNAL_ERROR', `${entry.name} produced a result that does not match its output schema.`, {
          tool: entry.name,
          issues: checked.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
        });
      }
      const structured = checked.data as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
      };
    } catch (err) {
      return errorResult(BridgeError.from(err));
    }
  };
  server.registerTool(
    entry.name,
    {
      description: `${entry.description} Requires scope ${entry.scope}.`,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Every call spends vendor credits, so repeating one is not free.
        idempotentHint: false,
        openWorldHint: true,
      },
    } as never,
    handler as never,
  );
}

/**
 * Race a call against its catalog deadline. The catalog has always named
 * one per tool (SOURCE_*_TIMEOUT_MS) and nothing enforced it: a vendor page
 * that hangs for its whole per-request timeout, times the retries, times
 * the pages of a split search, held the MCP call open far past what the
 * caller was promised. On expiry the caller gets SOURCE_UNAVAILABLE at once,
 * and the shared flag tells the item pool to issue no further vendor
 * request for a result nobody will receive. A call that finishes first
 * clears the timer, so the expiry promise never settles and never rejects
 * unobserved.
 */
async function withDeadline<T>(deadlineMs: number, run: (deadline: SourceDeadline) => Promise<T>): Promise<T> {
  const deadline: SourceDeadline = { deadlineMs, expired: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      reject(new BridgeError('SOURCE_UNAVAILABLE', `tool deadline of ${deadlineMs} ms exceeded`, { deadlineMs }));
    }, deadlineMs);
  });
  try {
    return await Promise.race([run(deadline), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch one catalogued source tool by name. Exported so a test can drive
 * the exact code path the MCP handler runs without an HTTP server. The
 * deadline is the handler's; a direct caller may omit it.
 */
export async function runSourceTool(
  source: CountdownSource,
  name: string,
  args: Record<string, unknown>,
  caller: SourceCaller,
  deadline?: SourceDeadline,
): Promise<Record<string, unknown>> {
  prescreenUrls(name, args);
  switch (name) {
    case SEARCH_TOOL_NAME:
      return (await source.search(parseInput(name, EbayApiSearchInput.safeParse(args)), caller)) as unknown as Record<string, unknown>;
    case ITEMS_TOOL_NAME:
      return (await source.items(parseInput(name, EbayApiItemsInput.safeParse(args)), caller, deadline)) as unknown as Record<string, unknown>;
    case SELLER_TOOL_NAME:
      return (await source.seller(parseInput(name, EbayApiSellerInput.safeParse(args)), caller)) as unknown as Record<string, unknown>;
    default:
      throw new BridgeError('INTERNAL_ERROR', `${name} is not a source tool.`, { tool: name });
  }
}

/**
 * Screen every url in the raw arguments before the schema sees them. The
 * item list is a union of two object shapes, and a union failure reports
 * "invalid input" at items.N with the url reason buried in the branch
 * errors, so a refused item URL used to surface as ACTION_BLOCKED with no
 * reason. Screening first gives the caller the reason and the code the
 * plan names for it (ORIGIN_DENIED); the schema check stays behind it as
 * the second line. A url that is not a string is left for the schema.
 */
function prescreenUrls(name: string, args: Record<string, unknown>): void {
  const urls: Array<{ path: string; url: unknown; kinds: EbayUrlKind[] }> = [];
  if (name === SEARCH_TOOL_NAME) urls.push({ path: 'url', url: args.url, kinds: ['search'] });
  if (name === SELLER_TOOL_NAME) urls.push({ path: 'url', url: args.url, kinds: ['seller'] });
  if (name === ITEMS_TOOL_NAME && Array.isArray(args.items)) {
    args.items.forEach((item: unknown, index) => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        urls.push({ path: `items.${index}.url`, url: (item as Record<string, unknown>).url, kinds: ['item'] });
      }
    });
  }
  for (const { path, url, kinds } of urls) {
    if (typeof url !== 'string') continue;
    const reason = screenEbayUrl(url, kinds);
    if (reason !== null) throw new BridgeError('ORIGIN_DENIED', reason, { url, path, tool: name });
  }
}

/**
 * Through MCP the SDK has already validated the arguments, so a failure
 * here means a direct caller. A url the §2 policy refuses is ORIGIN_DENIED,
 * the code the plan names for it; anything else is a blocked call, never a
 * retryable internal error.
 */
function parseInput<T>(name: string, result: { success: true; data: T } | { success: false; error: { issues: InputIssue[] } }): T {
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  const urlIssue = issues.find((issue) => issue.path.split('.').includes('url') && /url is not accepted/.test(issue.message));
  if (urlIssue !== undefined) {
    throw new BridgeError('ORIGIN_DENIED', urlIssue.message, { tool: name, path: urlIssue.path });
  }
  throw new BridgeError('ACTION_BLOCKED', `Invalid arguments for ${name}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`, {
    tool: name,
    issues,
  });
}

function assertReadScope(authInfo: SourceAuthInfo | undefined, entry: SourceToolCatalogEntry): void {
  const scopes = authInfo?.scopes ?? [];
  if (!scopeSatisfies(scopes, SCOPE_READ)) {
    throw new BridgeError('ACTION_BLOCKED', `Token lacks required scope ${entry.scope}.`, { requiredScope: entry.scope });
  }
}

/** The broker's identity ladder: OAuth subject, else client id, else null when OAuth is disabled. */
function callerOf(authInfo: SourceAuthInfo | undefined): SourceCaller {
  const subject = typeof authInfo?.extra?.subject === 'string' ? (authInfo.extra.subject as string) : (authInfo?.clientId ?? null);
  const traceparent = typeof authInfo?.extra?.traceparent === 'string' ? (authInfo.extra.traceparent as string) : null;
  return { subject, traceparent };
}
