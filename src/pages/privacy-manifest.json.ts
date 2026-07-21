import { serializePrivacyManifest } from "../../scripts/privacy-manifest-core.mjs";
import { privacyManifest } from "../privacy/manifest";

export const prerender = true;

export function GET(): Response {
  return new Response(serializePrivacyManifest(privacyManifest), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
