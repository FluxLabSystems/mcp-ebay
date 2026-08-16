/**
 * Container healthcheck (compose.yaml §23): exits 0 when /healthz answers.
 */
const port = process.env.PORT ?? '3000';

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
