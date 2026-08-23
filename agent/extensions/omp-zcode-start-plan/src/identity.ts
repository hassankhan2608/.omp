import { release } from "node:os";
import { ZCODE_CLIENT_VERSION } from "./constants";

export function zcodeIdentityHeaders(): Record<string, string> {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    "User-Agent": `ZCode/${ZCODE_CLIENT_VERSION}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": ZCODE_CLIENT_VERSION,
    "X-Release-Channel": "production",
    "X-Client-Language": locale,
    "X-Client-Timezone": timeZone,
    "X-Platform": "linux-x64",
    "X-Os-Category": "linux",
    "X-Os-Version": release(),
    "X-ZCode-Agent": "glm",
  };
}
