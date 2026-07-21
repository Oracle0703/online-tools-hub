const DIRECTIVE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
const SHA256_SOURCE_PATTERN = /^'sha256-[A-Za-z0-9+/]{43}='$/u;
const HASH_DIRECTIVE_NAMES = Object.freeze(["script-src", "style-src"]);
const CASE_INSENSITIVE_SOURCE_TOKENS = new Set([
  "'none'",
  "'self'",
  "data:",
  "blob:",
]);

function containsInvalidPolicyCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "," ||
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function failure(issues) {
  return Object.freeze({ ok: false, issues: Object.freeze([...issues]) });
}

function freezeDirectives(directives) {
  return Object.freeze(
    Object.fromEntries(
      [...directives].map(([name, tokens]) => [
        name,
        Object.freeze([...tokens]),
      ]),
    ),
  );
}

function parseDirectiveSource(value, label, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${label} must be a non-empty string`);
    return null;
  }
  if (containsInvalidPolicyCharacter(value)) {
    issues.push(`${label} contains an invalid policy character`);
    return null;
  }
  const parts = value.trim().split(/\s+/u);
  const name = parts.shift()?.toLowerCase() ?? "";
  if (!DIRECTIVE_NAME_PATTERN.test(name)) {
    issues.push(`${label} has an invalid directive name`);
    return null;
  }
  const tokens = parts.map((token) => {
    const normalized = token.toLowerCase();
    return CASE_INSENSITIVE_SOURCE_TOKENS.has(normalized) ? normalized : token;
  });
  if (tokens.length === 0) {
    issues.push(`${label} must contain an explicit source list`);
    return null;
  }
  if (new Set(tokens).size !== tokens.length) {
    issues.push(`${label} contains duplicate source tokens`);
    return null;
  }
  if (tokens.includes("'none'") && tokens.length !== 1) {
    issues.push(`${label} cannot combine 'none' with other source tokens`);
    return null;
  }
  return { name, tokens };
}

/**
 * Parses one CSP policy into a closed directive record. Duplicate directives,
 * malformed names and duplicate source tokens are rejected instead of relying
 * on browser first-directive-wins behaviour.
 */
export function parseContentSecurityPolicy(value) {
  const issues = [];
  if (typeof value !== "string" || value.trim() === "") {
    return failure(["policy must be a non-empty string"]);
  }
  if (containsInvalidPolicyCharacter(value)) {
    return failure(["policy contains an invalid policy character"]);
  }

  const directives = new Map();
  for (const segment of value.split(";")) {
    if (segment.trim() === "") continue;
    const parsed = parseDirectiveSource(segment, "policy directive", issues);
    if (parsed === null) continue;
    if (directives.has(parsed.name)) {
      issues.push(`policy contains duplicate directive '${parsed.name}'`);
      continue;
    }
    directives.set(parsed.name, parsed.tokens);
  }

  if (directives.size === 0) issues.push("policy must contain directives");
  return issues.length > 0
    ? failure(issues)
    : Object.freeze({ ok: true, directives: freezeDirectives(directives) });
}

function sameTokenSet(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((token) => actual.includes(token))
  );
}

/**
 * Validates the complete privacy CSP profile. Static directives must have the
 * exact declared token sets. script-src/style-src may add only SHA-256 hashes
 * beside 'self'. No undeclared or duplicate directive is accepted.
 */
export function validatePrivacyContentSecurityPolicy(
  policy,
  requiredDirectives,
) {
  const parsed = parseContentSecurityPolicy(policy);
  if (!parsed.ok) return parsed;

  const issues = [];
  if (!Array.isArray(requiredDirectives) || requiredDirectives.length === 0) {
    return failure(["requiredDirectives must be a non-empty array"]);
  }

  const expected = new Map();
  requiredDirectives.forEach((value, index) => {
    const directive = parseDirectiveSource(
      value,
      `requiredDirectives[${index}]`,
      issues,
    );
    if (directive === null) return;
    if (expected.has(directive.name)) {
      issues.push(`requiredDirectives duplicates '${directive.name}'`);
      return;
    }
    expected.set(directive.name, directive.tokens);
  });

  for (const [name, tokens] of expected) {
    const actual = parsed.directives[name];
    if (actual === undefined) {
      issues.push(`policy is missing directive '${name}'`);
    } else if (!sameTokenSet(actual, tokens)) {
      issues.push(`policy directive '${name}' has unexpected source tokens`);
    }
  }

  for (const name of HASH_DIRECTIVE_NAMES) {
    const tokens = parsed.directives[name];
    if (tokens === undefined) {
      issues.push(`policy is missing directive '${name}'`);
      continue;
    }
    const selfTokens = tokens.filter((token) => token === "'self'");
    const hashes = tokens.filter((token) => SHA256_SOURCE_PATTERN.test(token));
    if (
      selfTokens.length !== 1 ||
      hashes.length === 0 ||
      tokens.length !== selfTokens.length + hashes.length
    ) {
      issues.push(
        `policy directive '${name}' must contain only 'self' and SHA-256 hashes`,
      );
    }
  }

  const allowedNames = new Set([...expected.keys(), ...HASH_DIRECTIVE_NAMES]);
  for (const name of Object.keys(parsed.directives)) {
    if (!allowedNames.has(name)) {
      issues.push(`policy contains undeclared directive '${name}'`);
    }
  }

  return issues.length > 0
    ? failure(issues)
    : Object.freeze({ ok: true, directives: parsed.directives });
}
