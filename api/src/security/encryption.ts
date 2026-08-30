import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface DecryptedValue {
  value: string;
  needsRewrap: boolean;
}

export class EncryptionService {
  readonly #currentVersion: number;

  public constructor(
    private readonly currentKey: Buffer | null,
    private readonly previousKey: Buffer | null,
  ) {
    this.#currentVersion = previousKey ? 2 : 1;
  }

  public get configured(): boolean {
    return this.currentKey !== null;
  }

  public encrypt(platformId: string, credentialName: string, value: string): EncryptedValue {
    if (!this.currentKey) throw new Error('平台凭据加密密钥未配置');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.currentKey, iv);
    cipher.setAAD(this.#aad(platformId, credentialName, this.#currentVersion));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.#currentVersion,
    };
  }

  public decrypt(
    platformId: string,
    credentialName: string,
    encrypted: EncryptedValue,
  ): DecryptedValue {
    const keys = [
      ...(this.currentKey ? [{ key: this.currentKey, current: true }] : []),
      ...(this.previousKey ? [{ key: this.previousKey, current: false }] : []),
    ];
    for (const candidate of keys) {
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          candidate.key,
          Buffer.from(encrypted.iv, 'base64'),
        );
        decipher.setAAD(this.#aad(platformId, credentialName, encrypted.keyVersion));
        decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
        const value = Buffer.concat([
          decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        return {
          value,
          needsRewrap: !candidate.current || encrypted.keyVersion !== this.#currentVersion,
        };
      } catch {
        // Try the explicitly configured previous key before failing readiness.
      }
    }
    throw new Error('现有平台凭据无法使用已配置密钥解密');
  }

  public mask(value: string): string {
    const fingerprint = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
    return `已配置（指纹 ${fingerprint}）`;
  }

  #aad(platformId: string, credentialName: string, keyVersion: number): Buffer {
    return Buffer.from(`${platformId}\u0000${credentialName}\u0000${keyVersion}`, 'utf8');
  }
}
