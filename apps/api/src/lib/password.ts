import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 exports `Algorithm` as an ambient const enum, which
// verbatimModuleSyntax refuses to import across a native-binding module
// boundary. Argon2id is member value 2 and is already this library's
// default when `algorithm` is omitted — passing it explicitly keeps the
// choice self-documenting without importing the enum.
const ARGON2ID = 2;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID });
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  return verify(hashValue, plain, { algorithm: ARGON2ID });
}
