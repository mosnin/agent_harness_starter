import { existsSync } from "node:fs";
import { join } from "node:path";

/** Only host-owned resource locations; the renderer cannot select a bundle. */
export function companyOsBundlePath(
  moduleDirectory: string,
  override?: string,
) {
  if (override) return override;
  const candidates = [
    join(moduleDirectory, "company-os/bundle.json"),
    join(moduleDirectory, "../../../third_party/company-os/bundle.json"),
    join(moduleDirectory, "../../third_party/company-os/bundle.json"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}
