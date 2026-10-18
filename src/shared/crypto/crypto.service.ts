import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Field-level encryption for PII at rest.
 * - encrypt/decrypt: AES-256-GCM (authenticated), random 96-bit IV per value.
 * - blindIndex: keyed HMAC-SHA256 so we can look up / dedupe by National ID without storing it in clear.
 * In production the keys would come from a KMS/HSM with envelope encryption and rotation (the version prefix allows that).
 */
@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly blindIndexKey: Buffer;

  constructor(config: AppConfigService) {
    this.encryptionKey = CryptoService.parseKey(config.get('ENCRYPTION_KEY'), 'ENCRYPTION_KEY');
    this.blindIndexKey = CryptoService.parseKey(config.get('BLIND_INDEX_KEY'), 'BLIND_INDEX_KEY');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION || !iv || !tag || !ciphertext) {
      throw new Error('Unsupported ciphertext format');
    }
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.blindIndexKey).update(value).digest('hex');
  }

  private static parseKey(raw: string, name: string): Buffer {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(`${name} must be a base64-encoded 32-byte key`);
    }
    return key;
  }
}
