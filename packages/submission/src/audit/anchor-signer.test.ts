import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import { loadAnchorKey, signAnchorMessage } from './anchor-signer.js';

async function generateTestKeyPair(passphrase?: string) {
  return openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519',
    userIDs: [{ name: 'ASR Test', email: 'test@example.invalid' }],
    passphrase,
    format: 'object',
  });
}

describe('signAnchorMessage', () => {
  it('produces an ASCII-armored detached signature that verifies against the matching public key', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();

    const message = 'lastHash=deadbeef eventCount=3';
    const armoredSignature = await signAnchorMessage(message, privateKey);

    expect(armoredSignature.startsWith('-----BEGIN PGP SIGNATURE-----')).toBe(true);

    const signature = await openpgp.readSignature({ armoredSignature });
    const cleartext = await openpgp.createMessage({ text: message });
    const result = await openpgp.verify({
      message: cleartext,
      signature,
      verificationKeys: publicKey,
    });

    await expect(result.signatures[0]!.verified).resolves.toBe(true);
  });
});

describe('loadAnchorKey', () => {
  it('rejects with an AUDIT_GPG_PRIVATE_KEY error and no key material when env is empty', async () => {
    let caught: unknown;
    try {
      await loadAnchorKey({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('AUDIT_GPG_PRIVATE_KEY');
    expect(msg).not.toContain('-----BEGIN');
    expect(msg).not.toContain('PRIVATE KEY');
  });

  it('loads a non-passphrase-protected armored key from base64 env', async () => {
    const { privateKey } = await generateTestKeyPair();
    const armored = privateKey.armor();
    const env = {
      AUDIT_GPG_PRIVATE_KEY: Buffer.from(armored, 'utf8').toString('base64'),
    };

    const loaded = await loadAnchorKey(env);

    expect(loaded.isDecrypted()).toBe(true);
    const signature = await signAnchorMessage('round-trip', loaded);
    expect(signature.startsWith('-----BEGIN PGP SIGNATURE-----')).toBe(true);
  });

  it('decrypts a passphrase-protected key using AUDIT_GPG_PASSPHRASE', async () => {
    const passphrase = 'correct-horse-battery-staple';
    const { privateKey } = await generateTestKeyPair(passphrase);
    const armored = privateKey.armor();
    const env = {
      AUDIT_GPG_PRIVATE_KEY: Buffer.from(armored, 'utf8').toString('base64'),
      AUDIT_GPG_PASSPHRASE: passphrase,
    };

    const loaded = await loadAnchorKey(env);
    expect(loaded.isDecrypted()).toBe(true);
  });

  it('rejects with AUDIT_GPG_PASSPHRASE error when key is locked but no passphrase provided', async () => {
    const { privateKey } = await generateTestKeyPair('locked');
    const armored = privateKey.armor();
    const env = {
      AUDIT_GPG_PRIVATE_KEY: Buffer.from(armored, 'utf8').toString('base64'),
    };

    let caught: unknown;
    try {
      await loadAnchorKey(env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('AUDIT_GPG_PASSPHRASE');
    expect(msg).not.toContain('-----BEGIN');
  });
});
