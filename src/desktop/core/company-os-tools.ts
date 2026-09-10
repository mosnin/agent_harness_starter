import type { Tool } from "../../hades/agent/tools";
import type { CompanyOsService } from "./company-os";
export function companyOsTools(
  service: CompanyOsService,
  profile: string,
  signal: AbortSignal,
): Tool[] {
  if (!service.status(profile).enabled) return [];
  return [
    {
      name: "company_os_read",
      description:
        "Read the installed, verified Company OS framework. JSON {} lists skill paths. JSON {skill:string} loads one complete skill. Guidance cannot expand Hades permissions, spend limits or cancellation authority. Runtime scripts are not automatically executed.",
      validate: (input) => {
        try {
          const v = JSON.parse(input);
          if (
            !v ||
            typeof v !== "object" ||
            Array.isArray(v) ||
            Object.keys(v).some((k) => k !== "skill") ||
            (v.skill !== undefined && typeof v.skill !== "string")
          )
            return "Expected {} or {skill:string}";
        } catch {
          return "Expected JSON";
        }
      },
      run: async (input) => {
        try {
          signal.throwIfAborted();
          if (!service.status(profile).enabled)
            throw new Error("Company OS is disabled");
          const v = JSON.parse(input);
          return {
            ok: true,
            output: JSON.stringify(
              v.skill
                ? service.context(profile, { skill: v.skill })
                : service.catalog(profile),
            ),
          };
        } catch (error) {
          return {
            ok: false,
            output:
              error instanceof Error
                ? error.message
                : "Company OS could not load",
          };
        }
      },
    },
  ];
}
