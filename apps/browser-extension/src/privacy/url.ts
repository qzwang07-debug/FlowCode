/** Standard-mode URLs retain the origin/path and query keys, never credentials,
 * query values, or fragments that commonly carry tokens. */
export function sanitizeBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    const keys = [...new Set([...url.searchParams.keys()])].slice(0, 50);
    url.search = "";
    for (const key of keys)
      url.searchParams.append(key.slice(0, 128), "[redacted]");
    if (url.hash) url.hash = "#redacted";
    return url.toString().slice(0, 4096);
  } catch {
    return null;
  }
}
