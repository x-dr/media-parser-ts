import { readFile } from 'node:fs/promises';
import { ulid } from 'ulid';
import type { AppConfig } from '../config/env.js';
import {
  AdminRepository,
  type AdminRecord,
  type AdminSessionRecord,
} from '../database/repositories/admin-repository.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import { createAdminToken, hashToken, safeHashEqual } from './tokens.js';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

export class AdminAuthError extends Error {
  public constructor(
    public readonly code: 'ADMIN_UNAUTHORIZED' | 'ADMIN_RATE_LIMITED' | 'PASSWORD_INVALID',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export interface AdminIdentity {
  adminId: string;
  sessionId: string;
  username: string;
  mustChangePassword: boolean;
}

export interface AdminTokenPair {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  tokenType: 'Bearer';
  mustChangePassword: boolean;
}

export class AdminAuthService {
  public constructor(
    private readonly repository: AdminRepository,
    private readonly config: AppConfig,
  ) {}

  public async initialize(): Promise<void> {
    if (this.repository.findAdmin()) return;
    if (!this.config.adminBootstrapUsername || !this.config.adminBootstrapPasswordFile) {
      throw new Error('数据库中没有管理员，且缺少管理员引导凭据');
    }
    const username = normalizeUsername(this.config.adminBootstrapUsername);
    // The operator explicitly configures this secret-file path at startup.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fileContent = await readFile(this.config.adminBootstrapPasswordFile, 'utf8');
    const password = fileContent.replace(/\r?\n$/u, '');
    const digest = await hashPassword(password);
    const now = new Date().toISOString();
    this.repository.createAdmin({
      id: ulid(),
      username,
      passwordHash: digest.hash,
      passwordSalt: digest.salt,
      passwordParamsJson: digest.paramsJson,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async login(usernameInput: string, password: string, requestIp: string): Promise<AdminTokenPair> {
    const username = normalizeUsername(usernameInput);
    const now = new Date();
    const since = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
    if (this.repository.countRecentFailedLogins(username, requestIp, since) >= MAX_LOGIN_FAILURES) {
      throw new AdminAuthError('ADMIN_RATE_LIMITED', '登录尝试过于频繁', 429);
    }
    const admin = this.repository.findAdmin();
    if (!admin) throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    const passwordMatches = await verifyPassword(password, digestFromAdmin(admin));
    const successful = username === admin.username.toLowerCase() && passwordMatches;
    this.repository.recordLoginAttempt(username, requestIp, successful, now.toISOString());
    if (!successful) throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    return this.#createTokenPair(admin, ulid(), now);
  }

  public authenticateAccess(token: string): AdminIdentity {
    if (!token.startsWith('ma_access_')) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const tokenHash = hashToken(token);
    const session = this.repository.findSessionByAccessHash(tokenHash);
    if (
      !session ||
      session.revokedAt ||
      Date.parse(session.accessExpiresAt) <= Date.now() ||
      !safeHashEqual(tokenHash, session.accessTokenHash)
    ) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const admin = this.repository.findAdmin();
    if (admin?.id !== session.adminId) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    return {
      adminId: admin.id,
      sessionId: session.id,
      username: admin.username,
      mustChangePassword: admin.mustChangePassword,
    };
  }

  public refresh(refreshToken: string): AdminTokenPair {
    if (!refreshToken.startsWith('ma_refresh_')) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const tokenHash = hashToken(refreshToken);
    const previous = this.repository.findSessionByRefreshHash(tokenHash);
    if (!previous || !safeHashEqual(tokenHash, previous.refreshTokenHash)) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const now = new Date();
    if (previous.revokedAt) {
      this.repository.revokeFamily(previous.familyId, 'refresh_token_reuse', now.toISOString());
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    if (Date.parse(previous.refreshExpiresAt) <= now.getTime()) {
      this.repository.revokeSession(previous.id, 'refresh_expired', now.toISOString());
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const admin = this.repository.findAdmin();
    if (admin?.id !== previous.adminId) {
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    const generated = this.#generateSession(admin, previous.familyId, now);
    if (!this.repository.rotateSession(previous.id, generated.record, now.toISOString())) {
      this.repository.revokeFamily(previous.familyId, 'refresh_token_reuse', now.toISOString());
      throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
    }
    return generated.pair;
  }

  public logout(sessionId: string): void {
    this.repository.revokeSession(sessionId, 'logout', new Date().toISOString());
  }

  public async changePassword(
    identity: AdminIdentity,
    currentPassword: string,
    nextPassword: string,
  ): Promise<AdminTokenPair> {
    validatePassword(nextPassword);
    const admin = this.repository.findAdmin();
    if (admin?.id !== identity.adminId ||
        !(await verifyPassword(currentPassword, digestFromAdmin(admin)))) {
      throw new AdminAuthError('PASSWORD_INVALID', '当前密码不正确', 400);
    }
    const digest = await hashPassword(nextPassword);
    const now = new Date();
    this.repository.updatePassword(
      admin.id,
      digest.hash,
      digest.salt,
      digest.paramsJson,
      now.toISOString(),
    );
    this.repository.revokeAllSessions(admin.id, 'password_changed', now.toISOString());
    return this.#createTokenPair({ ...admin, mustChangePassword: false }, ulid(), now);
  }

  #createTokenPair(admin: AdminRecord, familyId: string, now: Date): AdminTokenPair {
    const generated = this.#generateSession(admin, familyId, now);
    this.repository.createSession(generated.record);
    return generated.pair;
  }

  #generateSession(
    admin: AdminRecord,
    familyId: string,
    now: Date,
  ): { record: AdminSessionRecord; pair: AdminTokenPair } {
    const accessToken = createAdminToken('access');
    const refreshToken = createAdminToken('refresh');
    const timestamp = now.toISOString();
    return {
      record: {
        id: ulid(),
        adminId: admin.id,
        familyId,
        accessTokenHash: hashToken(accessToken),
        accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS).toISOString(),
        refreshTokenHash: hashToken(refreshToken),
        refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS).toISOString(),
        createdAt: timestamp,
        lastUsedAt: timestamp,
        revokedAt: null,
        revokeReason: null,
      },
      pair: {
        accessToken,
        accessExpiresIn: ACCESS_TTL_MS / 1000,
        refreshToken,
        refreshExpiresIn: REFRESH_TTL_MS / 1000,
        tokenType: 'Bearer',
        mustChangePassword: admin.mustChangePassword,
      },
    };
  }
}

function normalizeUsername(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(normalized)) {
    throw new AdminAuthError('ADMIN_UNAUTHORIZED', '管理员认证失败', 401);
  }
  return normalized;
}

function digestFromAdmin(admin: AdminRecord): {
  hash: string;
  salt: string;
  paramsJson: string;
} {
  return {
    hash: admin.passwordHash,
    salt: admin.passwordSalt,
    paramsJson: admin.passwordParamsJson,
  };
}
