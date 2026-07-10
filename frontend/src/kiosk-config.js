import profilesData from "../../config/kiosk-profiles.json";
import { resolveKioskConfigFrom } from "../../config/kiosk-config-core.mjs";

// Thin browser binding: webpack inlines the profile JSON and the shared
// resolver (config/kiosk-config-core.mjs), so the UI and the Node host can
// never drift apart on clamp bounds, allowed sizes, or coercion rules.
export { asBool } from "../../config/kiosk-config-core.mjs";

export function resolveKioskConfig(input = {}) {
  return resolveKioskConfigFrom(profilesData, input);
}
