import { Buffer } from 'node:buffer';

export interface KeyRing {
  readonly activeId: string;
  get(id: string): Buffer | undefined;
  addKey(id: string, bytes: Buffer): void;
  setActive(id: string): void;
}

const PREVIOUS_KEY_PREFIX = 'AUDIT_HMAC_KEY_BYTES_';

export function loadKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): KeyRing {
  const activeId = env.AUDIT_HMAC_KEY_ID;
  const activeB64 = env.AUDIT_HMAC_KEY_BYTES;

  if (!activeId || !activeB64) {
    throw new Error(
      'AUDIT_HMAC_KEY_ID and AUDIT_HMAC_KEY_BYTES must be set to load the audit KeyRing',
    );
  }

  const activeBytes = Buffer.from(activeB64, 'base64');
  if (activeBytes.length !== 32) {
    throw new Error(
      `AUDIT_HMAC_KEY_BYTES must decode to 32 bytes (got ${activeBytes.length})`,
    );
  }

  const keys = new Map<string, Buffer>();
  keys.set(activeId, activeBytes);

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PREVIOUS_KEY_PREFIX) || !value) continue;
    const id = name.slice(PREVIOUS_KEY_PREFIX.length);
    if (!id || id === activeId) continue;
    keys.set(id, Buffer.from(value, 'base64'));
  }

  let currentActiveId = activeId;

  return {
    get activeId(): string {
      return currentActiveId;
    },
    get(id: string): Buffer | undefined {
      return keys.get(id);
    },
    addKey(id: string, bytes: Buffer): void {
      keys.set(id, bytes);
    },
    setActive(id: string): void {
      if (!keys.has(id)) {
        throw new Error(`cannot set active key: unknown key id '${id}'`);
      }
      currentActiveId = id;
    },
  };
}
