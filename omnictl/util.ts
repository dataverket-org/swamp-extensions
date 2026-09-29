/**
 * `@dataverket/omnictl` — URL validation and secret-redaction helpers.
 *
 * The `inventory` model shells out to `omnictl`; these helpers cover what the
 * subprocess boundary does not: validating the operator-supplied Omni endpoint
 * URL, and masking the service-account key from any text — `omnictl` stderr,
 * log lines, the scan summary — before it can leak.
 *
 * @module
 */

/**
 * Validate an operator-supplied URL. Requires `https:` — Omni's API is always
 * served over TLS, and rejecting `http:` is a minimal guard against an endpoint
 * pointing at an unintended plaintext service. The returned value has any
 * trailing slashes trimmed.
 */
export function assertHttpsUrl(raw: string, label: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`${label} must use https (got ${u.protocol}): ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Expand a leading `~/` from `HOME`, so a definition can name a key file the
 * way an operator does. Any other path is returned unchanged.
 */
function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error(`cannot expand ~ in ${path}: HOME is not set`);
  return home + path.slice(1);
}

/**
 * Read a secret out of a file named by a global argument, at call time. This
 * is how a definition points at a short-lived credential an operator's session
 * wrote without carrying the value itself: the path is not a secret, the file
 * is, and the file is expected to be mode 0600 and to expire. The content is
 * trimmed, since a file written by a shell usually ends in a newline, and an
 * empty file is an error rather than an empty credential.
 */
export function readSecretFile(rawPath: string, label: string): string {
  const path = expandHome(rawPath);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`${label}: ${path} does not exist`);
    }
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new Error(`${label}: ${path} is not readable`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${path} could not be read: ${reason}`);
  }
  const value = text.trim();
  if (value.length === 0) throw new Error(`${label}: ${path} is empty`);
  return value;
}

/**
 * Mask every occurrence of `secret` in `text` with `[REDACTED]`. The Omni
 * service-account key is a long opaque base64 string, so exact-substring
 * replacement is both sufficient and complete. An empty `secret` is a no-op.
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}
