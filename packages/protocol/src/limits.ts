/**
 * Normative size/time limits — SDD v0.5 §12, §16, §18.
 */

/** Artifacts at or under this size may travel inline in wire result JSON (§12). */
export const WIRE_INLINE_ARTIFACT_MAX_BYTES = 1 * 1024 * 1024;

/** Artifacts at or under this size may be returned as direct MCP image content (§16). */
export const MCP_INLINE_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

/** Full-page screenshots above this PNG size may fall back to JPEG q90 (§16). */
export const FULL_PAGE_PNG_JPEG_FALLBACK_BYTES = 8 * 1024 * 1024;

/** Original listing images pass through unrecompressed up to this size (§16). */
export const IMAGE_PASSTHROUGH_MAX_BYTES = 12 * 1024 * 1024;

/** Maximum single artifact size (§16). */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

/** Maximum aggregate artifact bytes for one tool call (§16). */
export const ARTIFACT_AGGREGATE_MAX_BYTES = 75 * 1024 * 1024;

/** MIME types allowed for unrecompressed image passthrough (§16). */
export const IMAGE_PASSTHROUGH_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;

/**
 * Passive raster MIME types an artifact may carry. Screenshots are
 * png/jpeg; listing images add webp/avif/gif. Active-content types
 * (svg+xml, html, xml) are rejected end to end so artifact downloads can
 * never render script on the gateway origin (audit F-06).
 */
export const ARTIFACT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;

export function isAllowedArtifactMime(mimeType: string): boolean {
  return (ARTIFACT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase().split(';')[0]!.trim());
}

/** Maximum accepted JSON body size on /mcp and /agent/pair (audit F-23). */
export const JSON_BODY_MAX_BYTES = 128 * 1024;

/** Default gateway artifact TTL seconds; max configurable (§16). */
export const ARTIFACT_TTL_DEFAULT_SECONDS = 900;
export const ARTIFACT_TTL_MAX_SECONDS = 3600;

/** Artifact cleanup cadence (§16, §21). */
export const ARTIFACT_CLEANUP_INTERVAL_SECONDS = 300;

/** Agent-local temp artifacts are deleted after upload or 30 minutes (§16). */
export const AGENT_TEMP_ARTIFACT_MAX_AGE_SECONDS = 1800;

/** Idempotency keys deduplicate command submissions for 10 minutes (§18). */
export const IDEMPOTENCY_WINDOW_SECONDS = 600;

/** Heartbeat cadence and miss threshold (§12.4). */
export const HEARTBEAT_INTERVAL_SECONDS = 20;
export const HEARTBEAT_MISS_LIMIT = 3;

/** Agent ack must arrive within 2 s of command receipt (§12.4). */
export const ACK_DEADLINE_MS = 2000;

/** Reconnect backoff schedule (§12.5): base delays in ms plus 0–20% jitter. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const RECONNECT_JITTER_RATIO = 0.2;

/** MCP protocol revision the gateway serves (§9). */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
