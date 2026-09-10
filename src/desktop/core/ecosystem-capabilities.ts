import type {
  PluginCapabilities,
  PluginDefinition,
  PluginWrite,
  PluginWriteCapability,
} from "./ecosystem-types";

const includes = (granted: string[], required: string[]) =>
  required.every((scope) => granted.includes(scope));

function grantedFields(capability: PluginWriteCapability, scopes: string[]) {
  return capability.fields.filter((field) =>
    includes(scopes, capability.fieldScopes?.[field] ?? []),
  );
}

/** Same capability check is used for UI disclosure and immediately before a write. */
export function canWritePlugin(
  definition: PluginDefinition,
  scopes: string[],
  input?: PluginWrite,
): boolean {
  if (!definition.adapter?.write || !definition.oauth?.writeScopes.length)
    return false;
  if (!definition.capabilities)
    return includes(scopes, definition.oauth.writeScopes);
  return definition.capabilities.writes.some((capability) => {
    if (
      !includes(
        scopes,
        capability.requiredScopes ?? definition.oauth!.writeScopes,
      )
    )
      return false;
    const fields = grantedFields(capability, scopes);
    if (
      !fields.length ||
      capability.requiredFields?.some((field) => !fields.includes(field))
    )
      return false;
    return (
      !input ||
      (capability.collection === input.collection &&
        capability.operation === input.operation &&
        Object.keys(input.data).length > 0 &&
        Object.keys(input.data).every((field) => fields.includes(field)) &&
        (capability.requiredFields ?? []).every((field) =>
          Object.hasOwn(input.data, field),
        ))
    );
  });
}

export function grantedPluginCapabilities(
  definition: PluginDefinition,
  scopes: string[],
): PluginCapabilities | undefined {
  if (!definition.capabilities) return undefined;
  return {
    ...definition.capabilities,
    reads: definition.capabilities.reads.filter((collection) =>
      includes(scopes, definition.capabilities!.readScopes?.[collection] ?? []),
    ),
    writes: definition.capabilities.writes
      .filter((capability) =>
        includes(
          scopes,
          capability.requiredScopes ?? definition.oauth?.writeScopes ?? [],
        ),
      )
      .map((capability) => ({
        ...capability,
        fields: grantedFields(capability, scopes),
      }))
      .filter(
        (capability) =>
          capability.fields.length > 0 &&
          (capability.requiredFields ?? []).every((field) =>
            capability.fields.includes(field),
          ),
      ),
  };
}
