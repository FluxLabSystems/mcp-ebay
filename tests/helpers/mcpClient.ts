/**
 * Minimal modern-era (2026-07-28) MCP HTTP client for contract/e2e tests.
 * Builds the per-request envelope the SDK requires: MCP-Protocol-Version,
 * Mcp-Method/Mcp-Name headers, and the params._meta envelope keys.
 */
import { MCP_PROTOCOL_VERSION } from '@browser-bridge/protocol';

export const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'bridge-tests', version: '0.1.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
} as const;

export interface JsonRpcResponse {
  status: number;
  body: {
    jsonrpc?: string;
    id?: number | string | null;
    result?: {
      tools?: Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown; description?: string }>;
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      [key: string]: unknown;
    };
    error?: { code: number; message: string; data?: unknown };
  };
}

export type FetchLike = (request: Request) => Promise<Response>;

export class ModernMcpClient {
  private id = 0;

  constructor(
    private readonly endpoint: string,
    private readonly doFetch: FetchLike,
    private readonly bearerToken?: string,
  ) {}

  async request(
    method: string,
    params: Record<string, unknown>,
    options: { toolName?: string; headers?: Record<string, string>; omitMeta?: boolean; omitEnvelopeHeaders?: boolean } = {},
  ): Promise<JsonRpcResponse> {
    this.id += 1;
    const body = {
      jsonrpc: '2.0',
      id: this.id,
      method,
      params: options.omitMeta === true ? params : { ...params, _meta: MODERN_META },
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(options.omitEnvelopeHeaders === true
        ? {}
        : {
            'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
            'Mcp-Method': method,
            ...(options.toolName === undefined ? {} : { 'Mcp-Name': options.toolName }),
          }),
      ...(this.bearerToken === undefined ? {} : { authorization: `Bearer ${this.bearerToken}` }),
      ...(options.headers ?? {}),
    };
    const response = await this.doFetch(
      new Request(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body) }),
    );
    const raw = await response.text();
    let parsed: JsonRpcResponse['body'] = {};
    try {
      parsed = JSON.parse(raw) as JsonRpcResponse['body'];
    } catch {
      // Legacy stateless serving streams SSE frames; take the first data line.
      const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine !== undefined) {
        try {
          parsed = JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse['body'];
        } catch {
          parsed = {};
        }
      }
    }
    return { status: response.status, body: parsed };
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.request('tools/list', {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.request('tools/call', { name, arguments: args }, { toolName: name });
  }
}
