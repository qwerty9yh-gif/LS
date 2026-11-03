// Classifies database connectivity failures so the API can answer with a safe,
// useful message instead of leaking pooler internals (user names, project refs).
const TRANSIENT_PATTERNS = [
  /\(ENOTFOUND\)\s*tenant\/user/i, // Supavisor: pooler tenant not (yet) resolvable
  /tenant\/user .* not found/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,
  /Connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /Can't reach database server/i,
  /Timed out fetching a new connection/i,
];
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'P1001', 'P1002', 'P1017', 'P2024']);

export function isDbConnectionError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  const text = `${err.message || ''} ${err.cause?.message || ''}`;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

export const DB_UNAVAILABLE_MESSAGE =
  'The database connection is temporarily unavailable. Please try again in a moment.';

/** Retry a read a few times on connection-level failures only. */
export async function withDbRetry(fn, { attempts = 3, delayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isDbConnectionError(err) || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
