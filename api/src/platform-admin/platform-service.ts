import {
  platformDefinitions,
  platformIds,
  type PlatformId,
} from '../config/platforms.js';
import { PlatformRepository } from '../database/repositories/platform-repository.js';
import type { CredentialService, CredentialStatus } from './credential-service.js';

export interface PlatformView {
  id: PlatformId;
  name: string;
  enabled: boolean;
  mediaTypes: readonly string[];
  credentials: CredentialStatus[];
  updatedAt: string;
  lastTest: {
    success: boolean;
    mediaTypes: string[];
    missingFields: string[];
    durationMs: number;
    errorCategory: string | null;
    createdAt: string;
  } | null;
}

export interface PublicPlatformView {
  id: PlatformId;
  name: string;
  enabled: boolean;
  mediaTypes: readonly string[];
  domains: readonly string[];
  updatedAt: string;
}

export class PlatformService {
  public constructor(
    private readonly repository: PlatformRepository,
    private readonly credentials: CredentialService,
  ) {}

  public list(): PlatformView[] {
    const settings = new Map(this.repository.listSettings().map((setting) => [setting.platformId, setting]));
    return platformIds.map((platformId) => {
      const setting = settings.get(platformId);
      if (!setting) throw new Error(`平台设置缺失：${platformId}`);
      const lastTest = this.repository.getLatestTestRun(platformId);
      return {
        id: platformId,
        name: platformDefinitions[platformId].displayName,
        enabled: setting.enabled,
        mediaTypes: platformDefinitions[platformId].mediaTypes,
        credentials: this.credentials.listStatus(platformId),
        updatedAt: setting.updatedAt,
        lastTest: lastTest ? {
          success: lastTest.success,
          mediaTypes: lastTest.mediaTypes,
          missingFields: lastTest.missingFields,
          durationMs: lastTest.durationMs,
          errorCategory: lastTest.errorCategory,
          createdAt: lastTest.createdAt,
        } : null,
      };
    });
  }

  public listPublic(): PublicPlatformView[] {
    const settings = new Map(this.repository.listSettings().map((setting) => [setting.platformId, setting]));
    return platformIds.map((platformId) => {
      const setting = settings.get(platformId);
      if (!setting) throw new Error(`平台设置缺失：${platformId}`);
      return {
        id: platformId,
        name: platformDefinitions[platformId].displayName,
        enabled: setting.enabled,
        mediaTypes: platformDefinitions[platformId].mediaTypes,
        domains: platformDefinitions[platformId].domains,
        updatedAt: setting.updatedAt,
      };
    });
  }

  public get(platformId: PlatformId): PlatformView | null {
    return this.list().find((platform) => platform.id === platformId) ?? null;
  }

  public isEnabled(platformId: PlatformId): boolean {
    return this.repository.getSetting(platformId)?.enabled ?? false;
  }

  public setEnabled(platformId: PlatformId, enabled: boolean): PlatformView | null {
    if (!this.repository.setEnabled(platformId, enabled, new Date().toISOString())) return null;
    return this.get(platformId);
  }
}
