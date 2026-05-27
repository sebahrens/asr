import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { loadKeyRing } from './keyring.js';

const keyB64 = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64');

describe('loadKeyRing', () => {
  it('loads the active key and previous keys from env vars', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
      AUDIT_HMAC_KEY_BYTES_k0: keyB64(0x00),
    };
    const ring = loadKeyRing(env);

    expect(ring.activeId).toBe('k1');

    const active = ring.get('k1');
    expect(active).toBeInstanceOf(Buffer);
    expect(active?.length).toBe(32);

    const previous = ring.get('k0');
    expect(previous).toBeInstanceOf(Buffer);
    expect(previous?.length).toBe(32);

    expect(ring.get('nope')).toBeUndefined();
  });

  it('throws when AUDIT_HMAC_KEY_BYTES does not decode to 32 bytes', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: Buffer.alloc(16, 0x11).toString('base64'),
    };
    expect(() => loadKeyRing(env)).toThrow(/32 bytes/);
  });

  it('throws when AUDIT_HMAC_KEY_ID or AUDIT_HMAC_KEY_BYTES is missing', () => {
    expect(() => loadKeyRing({ AUDIT_HMAC_KEY_ID: 'k1' })).toThrow();
    expect(() =>
      loadKeyRing({ AUDIT_HMAC_KEY_BYTES: keyB64(0x11) }),
    ).toThrow();
  });

  it('addKey extends the keyring at runtime', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
    };
    const ring = loadKeyRing(env);
    expect(ring.get('k2')).toBeUndefined();

    const k2 = Buffer.alloc(32, 0x22);
    ring.addKey('k2', k2);
    expect(ring.get('k2')).toEqual(k2);
  });

  it('does not override the active key with a same-id previous-key env var', () => {
    const active = keyB64(0x11);
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: active,
      AUDIT_HMAC_KEY_BYTES_k1: keyB64(0x99),
    };
    const ring = loadKeyRing(env);
    expect(ring.get('k1')?.equals(Buffer.from(active, 'base64'))).toBe(true);
  });
});
