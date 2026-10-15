const PATTERNS: Array<[RegExp, string]> = [
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^:\s\/@]+):([^@\s]+)@/gi, "$1://$2:[REDACTED]@"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY_ID]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(authorization|x-api-key|api[_-]?key|token|secret|password|passwd|pwd)(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, "$1$2[REDACTED]"],
];

const known = new Set<string>();

/** Register an exact secret value (e.g. a loaded credential) so it is masked wherever it appears. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) known.add(value);
}
export function clearSecrets(): void {
  known.clear();
}

export function redact(input: string): string {
  let out = input;
  // Longest first so substrings of longer secrets don't leave fragments.
  for (const s of [...known].sort((a, b) => b.length - a.length)) out = out.split(s).join("[REDACTED]");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact every string in a JSON-like value (keys too). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[redact(k)] = redactDeep(v);
    return o as T;
  }
  return value;
}
