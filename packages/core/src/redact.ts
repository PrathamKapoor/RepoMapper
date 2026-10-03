/**
 * Secret redaction.
 *
 * Repositories are untrusted input and frequently contain committed credentials.
 * Evidence excerpts are stored, returned by the API and rendered in the UI, so
 * every excerpt passes through here first. Redaction is deliberately aggressive:
 * over-redacting a code sample is cheap, leaking a live key is not.
 */

/** Patterns for well-known credential shapes. Ordered: first match wins per span. */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'bearer-token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  },
  {
    name: 'key-value-secret',
    // key=value / key: value where the key name implies a credential.
    pattern:
      /\b((?:api[_-]?key|apikey|secret|passwd|password|token|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*)(["']?)([^\s"',;]{6,})\2/gi,
  },
  {
    name: 'credential-in-url',
    // Connection strings with inline credentials.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },
];

/** Replaces a detected secret with a stable, non-reversible marker. */
export const REDACTION_MARKER = '[REDACTED]';

function redactMatch(name: string, raw: string): string {
  // For key=value patterns keep the key so evidence stays meaningful.
  const eq = raw.match(/^([^:=]*[:=]\s*)/);
  if (eq?.[1]) {
    return `${eq[1]}${REDACTION_MARKER}`;
  }
  void name;
  return REDACTION_MARKER;
}

/** Redacts known credential shapes from arbitrary text. */
export function redactSecrets(input: string): string {
  if (input.length === 0) return input;
  let output = input;

  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match) => {
      // Connection strings: keep scheme and username, drop the password.
      const uri = match.match(/^([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/i);
      if (uri) return `${uri[1]}${uri[2]}:${REDACTION_MARKER}@`;
      const bearer = match.match(/^([Bb]earer\s+)/);
      if (bearer) return `${bearer[1]}${REDACTION_MARKER}`;
      return redactMatch('', match);
    });
  }

  return output;
}

/** Names of the secret patterns that fired, for audit logging. Never logs the value. */
export function detectSecretKinds(input: string): string[] {
  const found = new Set<string>();
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) found.add(name);
  }
  return [...found];
}
