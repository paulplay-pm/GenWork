interface Attempt {
  count: number;
  until: number;
}

const attempts = new Map<string, Attempt>();
const FAILURE_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function checkLoginRate(orgUser: string): boolean {
  const e = attempts.get(orgUser);
  if (e && Date.now() < e.until) return false;
  if (!e) attempts.set(orgUser, { count: 0, until: 0 });
  return true;
}

export function recordLoginFailure(orgUser: string): void {
  const e = attempts.get(orgUser) ?? { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= FAILURE_THRESHOLD) e.until = Date.now() + LOCKOUT_MS;
  attempts.set(orgUser, e);
}

export function clearLoginAttempts(orgUser: string): void {
  attempts.delete(orgUser);
}

// exported for tests
export function _resetForTests(): void {
  attempts.clear();
}