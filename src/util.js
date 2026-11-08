// Small pure helpers (kept separate so they are easy to unit test).

export function redactUrl(u) {
  if (!u) return "";
  if (u.startsWith("data:")) return u.slice(0, 60) + (u.length > 60 ? "…" : "");
  try {
    const url = new URL(u);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    const keys = [...new Set([...url.searchParams.keys()])];
    for (const k of keys) {
      if (/(token|key|auth|pass|secret|session|sig|signature|code|credential|jwt|bearer|cookie)/i.test(k)) url.searchParams.set(k, "REDACTED");
    }
    const s = url.toString();
    return s.length > 300 ? s.slice(0, 299) + "…" : s;
  } catch {
    return u.length > 300 ? u.slice(0, 299) + "…" : u;
  }
}

export function formatBytes(n) {
  if (n == null || n === 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeOf(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

const SCHEMELESS_OK = /^(about|data|javascript|file|mailto|view-source|blob|moz-extension|resource|chrome):/i;

/** Add a scheme to bare URLs: https:// by default, http:// for local addresses. */
export function normalizeUrl(url) {
  const u = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || SCHEMELESS_OK.test(u)) return u;
  if (/^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[a-z0-9-]+\.(localhost|local|test))(:\d+)?(\/|\?|#|$)/i.test(u)) {
    return `http://${u}`;
  }
  return `https://${u}`;
}
