import type { AppConfig } from '../config/env.js';
import {
  getCredentialDefinition,
  platformDefinitions,
  type PlatformId,
} from '../config/platforms.js';
import {
  PlatformRepository,
  type PlatformSecretRecord,
} from '../database/repositories/platform-repository.js';
import { EncryptionService } from '../security/encryption.js';

export interface CredentialStatus {
  name: string;
  required: boolean;
  configured: boolean;
  source: 'database' | 'environment' | 'none';
  masked: string | null;
  updatedAt: string | null;
}

export class CredentialService {
  public constructor(
    private readonly repository: PlatformRepository,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfig,
  ) {}

  public listStatus(platformId: PlatformId): CredentialStatus[] {
    return platformDefinitions[platformId].credentials.map((definition) => {
      const stored = this.repository.getSecret(platformId, definition.name);
      if (stored) {
        return {
          name: definition.name,
          required: definition.required,
          configured: true,
          source: 'database' as const,
          masked: stored.maskedHint,
          updatedAt: stored.updatedAt,
        };
      }
      const environmentValue = this.config.credentialEnvironment[definition.environmentVariable];
      if (environmentValue) {
        return {
          name: definition.name,
          required: definition.required,
          configured: true,
          source: 'environment' as const,
          masked: this.encryption.mask(environmentValue),
          updatedAt: null,
        };
      }
      return {
        name: definition.name,
        required: definition.required,
        configured: false,
        source: 'none' as const,
        masked: null,
        updatedAt: null,
      };
    });
  }

  public getCredentials(platformId: PlatformId): Readonly<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const definition of platformDefinitions[platformId].credentials) {
      const stored = this.repository.getSecret(platformId, definition.name);
      if (stored) {
        const decrypted = this.encryption.decrypt(platformId, definition.name, stored);
        values[definition.name] = decrypted.value;
        if (decrypted.needsRewrap) this.#store(platformId, definition.name, decrypted.value, stored.createdAt);
        continue;
      }
      const environmentValue = this.config.credentialEnvironment[definition.environmentVariable];
      if (environmentValue) values[definition.name] = environmentValue;
    }
    return Object.freeze(values);
  }

  public setCredential(platformId: PlatformId, credentialName: string, value: string): CredentialStatus {
    const definition = getCredentialDefinition(platformId, credentialName);
    if (!definition) throw new Error('该平台不允许此凭据名称');
    if (!value.trim() || value.length > 16_384) throw new Error('凭据不能为空且不能超过 16384 个字符');
    this.#store(platformId, credentialName, value, new Date().toISOString());
    return this.listStatus(platformId).find((status) => status.name === credentialName) as CredentialStatus;
  }

  public deleteCredential(platformId: PlatformId, credentialName: string): boolean {
    if (!getCredentialDefinition(platformId, credentialName)) throw new Error('该平台不允许此凭据名称');
    return this.repository.deleteSecret(platformId, credentialName);
  }

  public checkReady(): void {
    if (!this.encryption.configured) throw new Error('平台凭据加密密钥未配置');
    for (const secret of this.repository.listSecrets()) {
      this.encryption.decrypt(secret.platformId, secret.credentialName, secret);
    }
  }

  #store(platformId: PlatformId, credentialName: string, value: string, createdAt: string): void {
    const encrypted = this.encryption.encrypt(platformId, credentialName, value);
    const now = new Date().toISOString();
    const record: PlatformSecretRecord = {
      platformId,
      credentialName,
      ...encrypted,
      maskedHint: this.encryption.mask(value),
      createdAt,
      updatedAt: now,
    };
    this.repository.upsertSecret(record);
  }
}
