import { useAuthStore } from './store';

export function useAuth() {
  const token = useAuthStore((s) => s.token);
  const claims = useAuthStore((s) => s.claims);
  const hasCapability = useAuthStore((s) => s.hasCapability);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  return { token, claims, hasCapability, login, logout };
}