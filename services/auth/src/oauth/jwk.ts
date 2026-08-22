export interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  /** oct-key secret material (base64url). */
  k?: string;
  [key: string]: unknown;
}

export function asJwk(value: unknown): Jwk | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Jwk;
}
