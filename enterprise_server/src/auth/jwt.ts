import { SignJWT, jwtVerify } from 'jose';

export interface Claims {
  sub: string;
  orgId: string;
  roles: string[];
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be ≥32 chars');
  return new TextEncoder().encode(s);
}

export async function signToken(c: Claims): Promise<string> {
  return new SignJWT({ orgId: c.orgId, roles: c.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Claims> {
  const { payload } = await jwtVerify(token, secret());
  return {
    sub: payload.sub as string,
    orgId: (payload as unknown as { orgId: string }).orgId,
    roles: ((payload as unknown as { roles?: string[] }).roles) ?? [],
  };
}