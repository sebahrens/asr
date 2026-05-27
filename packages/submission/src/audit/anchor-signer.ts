import * as openpgp from 'openpgp';
import type { PrivateKey } from 'openpgp';

export async function loadAnchorKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivateKey> {
  const armoredB64 = env.AUDIT_GPG_PRIVATE_KEY;
  if (!armoredB64) {
    throw new Error('AUDIT_GPG_PRIVATE_KEY missing');
  }

  let armored: string;
  try {
    armored = Buffer.from(armoredB64, 'base64').toString('utf8');
  } catch {
    throw new Error('AUDIT_GPG_PRIVATE_KEY is not valid base64');
  }

  let key: PrivateKey;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armored });
  } catch {
    throw new Error('AUDIT_GPG_PRIVATE_KEY could not be parsed');
  }

  if (key.isDecrypted()) {
    return key;
  }

  const passphrase = env.AUDIT_GPG_PASSPHRASE;
  if (!passphrase) {
    throw new Error('AUDIT_GPG_PASSPHRASE missing');
  }

  try {
    return await openpgp.decryptKey({ privateKey: key, passphrase });
  } catch {
    throw new Error('AUDIT_GPG_PASSPHRASE did not unlock AUDIT_GPG_PRIVATE_KEY');
  }
}

export async function signAnchorMessage(
  message: string,
  key: PrivateKey,
): Promise<string> {
  const msg = await openpgp.createMessage({ text: message });
  const signed = await openpgp.sign({
    message: msg,
    signingKeys: key,
    detached: true,
    format: 'armored',
  });
  return signed as string;
}
