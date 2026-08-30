import type { FastifyBaseLogger } from 'fastify';
import { ulid } from 'ulid';
import type { AppConfig } from '../config/env.js';
import { detectPlatform, platformDefinitions, type PlatformId } from '../config/platforms.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { AppError, UpstreamError } from '../core/errors.js';
import { hasMedia, type MediaResult } from '../core/media-result.js';
import { getParserRegistration } from '../core/parser-registry.js';
import { PlatformRepository } from '../database/repositories/platform-repository.js';
import { HttpSession } from '../http/http-session.js';
import { RedirectResolver } from '../http/redirect-resolver.js';
import { extractShareUrl } from '../http/url-tools.js';
import type { CredentialService } from './credential-service.js';
import { defaultPlatformSamples } from './platform-test-samples.js';

export class PlatformTestError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PlatformTestError';
  }
}

export interface PlatformTestOutput {
  platformId: PlatformId;
  success: boolean;
  mediaTypes: string[];
  missingFields: string[];
  durationMs: number;
  errorCategory: string | null;
  createdAt: string;
}

export class PlatformTestService {
  #running = false;
  readonly #redirectResolver: RedirectResolver;

  public constructor(
    private readonly config: AppConfig,
    private readonly repository: PlatformRepository,
    private readonly credentials: CredentialService,
    private readonly shutdownSignal: AbortSignal,
  ) {
    this.#redirectResolver = new RedirectResolver({ timeoutMs: config.upstreamTimeoutMs });
  }

  public async run(input: {
    platformId: PlatformId;
    adminId: string;
    text?: string;
    requestId: string;
    signal: AbortSignal;
    logger: FastifyBaseLogger;
  }): Promise<PlatformTestOutput> {
    if (this.#running) throw new PlatformTestError('PLATFORM_TEST_BUSY', '已有平台测试正在运行', 409);
    const latest = this.repository.getLatestTestRun(input.platformId);
    if (latest && Date.now() - Date.parse(latest.createdAt) < 60_000) {
      throw new PlatformTestError('PLATFORM_TEST_COOLDOWN', '同一平台测试需间隔 60 秒', 429);
    }
    this.#running = true;
    const startedAt = Date.now();
    let mediaTypes: string[] = [];
    let missingFields: string[] = [];
    let errorCategory: string | null = null;
    let success = false;
    try {
      const text = input.text?.trim() || defaultPlatformSamples[input.platformId];
      const shareUrl = extractShareUrl(text);
      if (!shareUrl) throw new PlatformTestError('URL_NOT_FOUND', '未找到有效的分享链接', 400);
      const signal = AbortSignal.any([
        input.signal,
        this.shutdownSignal,
        AbortSignal.timeout(this.config.parseTimeoutMs),
      ]);
      const realUrl = await this.#redirectResolver.resolve(shareUrl, signal);
      const detected = detectPlatform(realUrl);
      if (detected !== input.platformId) {
        throw new PlatformTestError('PLATFORM_MISMATCH', '测试链接与目标平台不匹配', 400);
      }
      const registration = getParserRegistration(input.platformId);
      const session = new HttpSession({
        allowedHosts: [
          ...platformDefinitions[input.platformId].domains,
          ...registration.allowedHosts,
        ],
        defaultHeaders: { 'user-agent': DEFAULT_DESKTOP_USER_AGENT },
        timeoutMs: this.config.upstreamTimeoutMs,
      });
      const context = {
        requestId: input.requestId,
        apiClientId: 'admin-test',
        apiKeyId: 'admin-test',
        platform: input.platformId,
        originalUrl: shareUrl,
        realUrl,
        session,
        signal,
        logger: input.logger,
        credentials: this.credentials.getCredentials(input.platformId),
      };
      const parsed = await registration.factory(context).parse(context);
      mediaTypes = detectMediaTypes(parsed);
      missingFields = detectMissingFields(parsed);
      success = hasMedia(parsed);
      if (!success) errorCategory = 'media_not_found';
    } catch (error) {
      errorCategory = categorize(error);
      input.logger.warn(
        { request_id: input.requestId, platform_id: input.platformId, error_category: errorCategory },
        'controlled platform test failed',
      );
    } finally {
      this.#running = false;
    }
    const now = new Date();
    const output: PlatformTestOutput = {
      platformId: input.platformId,
      success,
      mediaTypes,
      missingFields,
      durationMs: Date.now() - startedAt,
      errorCategory,
      createdAt: now.toISOString(),
    };
    this.repository.createTestRun({
      id: ulid(),
      platformId: input.platformId,
      adminId: input.adminId,
      success,
      mediaTypes,
      missingFields,
      durationMs: output.durationMs,
      errorCategory,
      createdAt: output.createdAt,
      expiresAt: new Date(
        now.getTime() + (this.config.logRetentionDays * 24 * 60 * 60 * 1000),
      ).toISOString(),
    });
    return output;
  }
}

function detectMediaTypes(result: MediaResult): string[] {
  const types: string[] = [];
  if (result.videoUrl || result.videoList.length > 0) types.push('video');
  if (result.imageList.length > 0) types.push('images');
  if (result.imageList.some((item) => typeof item !== 'string' && Boolean(item.livePhotoUrl))) {
    types.push('live_media');
  }
  if (result.audioUrl) types.push('audio');
  if (result.subtitles && result.subtitles.length > 0) types.push('subtitles');
  return types;
}

function detectMissingFields(result: MediaResult): string[] {
  return [
    ...(!hasMedia(result) ? ['media'] : []),
    ...(!result.title ? ['title'] : []),
    ...(!result.coverUrl ? ['cover'] : []),
    ...(!result.author ? ['author'] : []),
  ];
}

function categorize(error: unknown): string {
  if (error instanceof PlatformTestError || error instanceof AppError) return error.code.toLowerCase();
  if (error instanceof UpstreamError) return `upstream_${error.category}`;
  return 'internal_error';
}
