import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export interface PasswordDigest {
  hash: string;
  salt: string;
  paramsJson: string;
}

interface PasswordParameters {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

const DEFAULT_PARAMETERS: PasswordParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
};

export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new Error('密码长度必须为 12 到 128 个字符');
  }
}

async function derive(password: string, salt: Buffer, parameters: PasswordParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  validatePassword(password);
  const salt = randomBytes(32);
  const hash = await derive(password, salt, DEFAULT_PARAMETERS);
  return {
    hash: hash.toString('base64'),
    salt: salt.toString('base64'),
    paramsJson: JSON.stringify(DEFAULT_PARAMETERS),
  };
}

export async function verifyPassword(
  password: string,
  digest: PasswordDigest,
): Promise<boolean> {
  let parameters: PasswordParameters;
  try {
    parameters = JSON.parse(digest.paramsJson) as PasswordParameters;
  } catch {
    return false;
  }
  if (
    !Number.isInteger(parameters.N) ||
    !Number.isInteger(parameters.r) ||
    !Number.isInteger(parameters.p) ||
    !Number.isInteger(parameters.keyLength) ||
    parameters.keyLength < 32 ||
    parameters.keyLength > 128
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(digest.hash, 'base64');
    const actual = await derive(password, Buffer.from(digest.salt, 'base64'), parameters);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
