import { describe, expect, it } from "vitest";

import {
  parseContentSecurityPolicy,
  validatePrivacyContentSecurityPolicy,
} from "../../scripts/privacy-csp-core.mjs";
import { PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES } from "../../scripts/privacy-manifest-core.mjs";

const HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";

function policy(...replacements: string[]): string {
  return [
    ...PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES,
    `script-src 'self' ${HASH}`,
    `style-src 'self' ${HASH}`,
    ...replacements,
  ].join("; ");
}

describe("strict privacy CSP", () => {
  it("accepts the complete profile independent of directive/source order", () => {
    const value = [
      `STYLE-SRC ${HASH} 'SELF'`,
      ...[...PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES].reverse(),
      `script-src ${HASH} 'self'`,
    ].join(" ;\t");

    expect(
      validatePrivacyContentSecurityPolicy(
        value,
        PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES,
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [
      "extra source",
      policy().replace(
        "connect-src 'none'",
        "connect-src 'none' https://evil.test",
      ),
    ],
    ["duplicate directive", `${policy()}; connect-src https://evil.test`],
    [
      "remote script",
      policy().replace(
        `script-src 'self' ${HASH}`,
        `script-src 'self' ${HASH} https://evil.test`,
      ),
    ],
    [
      "missing hash",
      policy().replace(`style-src 'self' ${HASH}`, "style-src 'self'"),
    ],
    [
      "duplicate token",
      policy().replace("connect-src 'none'", "connect-src 'none' 'none'"),
    ],
    [
      "none mixed with a source",
      policy().replace("connect-src 'none'", "connect-src 'none' https:"),
    ],
    [
      "missing semicolon",
      policy().replace(
        "default-src 'self'; base-uri",
        "default-src 'self' base-uri",
      ),
    ],
    ["comma policy list", `${policy()}, ${policy()}`],
    ["control character", `${policy()}\u0000`],
    ["undeclared directive", `${policy()}; child-src 'none'`],
  ])("rejects %s", (_name, value) => {
    expect(
      validatePrivacyContentSecurityPolicy(
        value,
        PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES,
      ).ok,
    ).toBe(false);
  });

  it("rejects duplicate directives during parsing", () => {
    expect(
      parseContentSecurityPolicy("connect-src 'none'; connect-src 'self'"),
    ).toMatchObject({ ok: false });
  });
});
