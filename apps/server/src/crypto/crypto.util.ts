import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM encryption for at-rest API key storage.
 *
 * Format (base64-url encoded, joined with `.`):
 *   <salt>.<iv>.<ciphertext>.<authTag>
 *
 * Key derivation: scrypt(AGENTHUB_SECRET, salt). When AGENTHUB_SECRET is
 * absent we fall back to a fixed string + WARN — that means in development
 * keys are encrypted but anyone with the DB dump *and* this codebase can
 * decrypt them. Set AGENTHUB_SECRET in .env for real deployments.
 *
 * Salt is per-record (16 bytes) so identical plaintexts produce different
 * ciphertexts and key rotation could be done off-line if needed.
 */

const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const TAG_LEN = 16;

let warnedAboutFallback = false;

function rawSecret(): string {
  const s = process.env.AGENTHUB_SECRET;
  if (s && s.length >= 16) return s;
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      '[crypto] AGENTHUB_SECRET not set or too short — using insecure dev fallback. ' +
        'Set it to a 32+ char random string in .env for at-rest API key encryption.',
    );
  }
  return 'agenthub-dev-fallback-secret-do-not-use-in-prod';
}

function deriveKey(salt: Buffer): Buffer {
  // scrypt is deliberately slow; called only on save/load, not per request.
  return scryptSync(rawSecret(), salt, KEY_LEN);
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64(salt), b64(iv), b64(ct), b64(tag)].join('.');
}

export function decryptSecret(blob: string): string {
  if (!blob) return '';
  const parts = blob.split('.');
  if (parts.length !== 4) throw new Error('crypto: bad ciphertext format');
  const [saltB64, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  const salt = unb64(saltB64);
  const iv = unb64(ivB64);
  const ct = unb64(ctB64);
  const tag = unb64(tagB64);
  if (tag.length !== TAG_LEN) throw new Error('crypto: bad auth tag length');
  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Convenience: mask a secret for safe logging (`sk-...abcd`). */
export function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
