import type { HadesPlugin } from "../plugins/plugin";
import type { PluginManager } from "../plugins/manager";
import { validateManifest, type ModuleManifest } from "./manifest";
import { resolveModules } from "./resolver";

/**
 * A plugin shipped as a package: a manifest (declaring capabilities, provided
 * hooks, and the **permissions it requests**) plus a factory. The manifest is
 * what makes plugins *modular and governed* — the loader can vet a plugin's
 * declared permissions before it ever runs.
 */
export interface PluginPackage {
  manifest: ModuleManifest;
  create: () => HadesPlugin;
}

/** Decide whether a package may hold a permission. */
export type PermissionGrant = (permission: string, manifest: ModuleManifest) => boolean;

export interface PluginPackageLoaderOptions {
  /** Explicitly allowed permissions (deny-by-default for anything else). */
  allowedPermissions?: string[];
  /** Custom grant logic (overrides `allowedPermissions`). */
  grant?: PermissionGrant;
}

export interface InstallResult {
  ok: boolean;
  /** Permissions the package requested but was not granted. */
  denied?: string[];
  error?: string;
}

/**
 * Installs plugin packages into a live {@link PluginManager}, enforcing declared
 * permissions **deny-by-default**: a package that requests any permission it
 * isn't granted is refused before its code runs (returned as `denied`). Packages
 * requesting nothing always pass. `installAll` resolves dependency order first.
 * This is the governed, modular plugin surface — stricter than a bare registry.
 */
export class PluginPackageLoader {
  private installed = new Map<string, ModuleManifest>();
  private readonly grant: PermissionGrant;

  constructor(
    private readonly manager: PluginManager,
    opts: PluginPackageLoaderOptions = {}
  ) {
    const allow = new Set(opts.allowedPermissions ?? []);
    this.grant = opts.grant ?? ((perm) => allow.has(perm));
  }

  /** Permissions this package requests that are NOT granted. */
  deniedPermissions(manifest: ModuleManifest): string[] {
    return (manifest.permissions ?? []).filter((p) => !this.grant(p, manifest));
  }

  async install(pkg: PluginPackage): Promise<InstallResult> {
    const v = validateManifest(pkg.manifest);
    if (!v.ok) return { ok: false, error: `invalid manifest: ${v.errors.join("; ")}` };
    if (pkg.manifest.kind !== "plugin") return { ok: false, error: `not a plugin package: kind=${pkg.manifest.kind}` };

    const denied = this.deniedPermissions(pkg.manifest);
    if (denied.length) return { ok: false, denied };

    try {
      await this.manager.register(pkg.create());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.installed.set(pkg.manifest.name, pkg.manifest);
    return { ok: true };
  }

  /** Install a set in dependency-first order; stops at the first failure. */
  async installAll(pkgs: PluginPackage[]): Promise<InstallResult[]> {
    const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
    const res = resolveModules(pkgs.map((p) => p.manifest), pkgs.map((p) => p.manifest.name));
    if (!res.ok) return [{ ok: false, error: res.errors.join("; ") }];
    const results: InstallResult[] = [];
    for (const manifest of res.order) {
      const pkg = byName.get(manifest.name);
      if (!pkg) continue;
      const r = await this.install(pkg);
      results.push(r);
      if (!r.ok) break;
    }
    return results;
  }

  isInstalled(name: string): boolean {
    return this.installed.has(name);
  }
  list(): ModuleManifest[] {
    return [...this.installed.values()];
  }
}
