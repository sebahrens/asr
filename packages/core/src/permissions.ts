import type { PermissionsManifest } from './types.js';

const FILESYSTEM_LEVEL: Record<PermissionsManifest['filesystem'], number> = {
  none: 0,
  'read-own': 1,
  'read-write-own': 2,
};

function grantsAnyCapability(p: PermissionsManifest): boolean {
  if (p.network) return true;
  if (p.subprocess) return true;
  if (FILESYSTEM_LEVEL[p.filesystem] > 0) return true;
  if ((p.networkHosts ?? []).length > 0) return true;
  if (p.environment.length > 0) return true;
  return false;
}

export function isPermissionsExpanded(
  before: PermissionsManifest | null,
  after: PermissionsManifest,
): boolean {
  if (before === null) {
    return grantsAnyCapability(after);
  }

  if (!before.network && after.network) return true;
  if (!before.subprocess && after.subprocess) return true;
  if (FILESYSTEM_LEVEL[after.filesystem] > FILESYSTEM_LEVEL[before.filesystem]) return true;

  const beforeNetworkHosts = before.networkHosts ?? [];
  const afterNetworkHosts = after.networkHosts ?? [];
  if (after.network && beforeNetworkHosts.length > 0 && afterNetworkHosts.length === 0) {
    return true;
  }

  const beforeHosts = new Set(beforeNetworkHosts);
  for (const host of afterNetworkHosts) {
    if (!beforeHosts.has(host)) return true;
  }

  const beforeEnv = new Set(before.environment);
  for (const v of after.environment) {
    if (!beforeEnv.has(v)) return true;
  }

  return false;
}
