export type ParsedContentSecurityPolicy = Readonly<
  Record<string, readonly string[]>
>;

export type ContentSecurityPolicyValidationResult =
  | Readonly<{ ok: true; directives: ParsedContentSecurityPolicy }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

export function parseContentSecurityPolicy(
  value: unknown,
): ContentSecurityPolicyValidationResult;

export function validatePrivacyContentSecurityPolicy(
  policy: unknown,
  requiredDirectives: unknown,
): ContentSecurityPolicyValidationResult;
