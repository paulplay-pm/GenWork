import type { Session } from './sessionStorage';

let current: Session | null = null;

export const loginGate = {
  install(): void {
    // main.ts 在启动时调一次（占位，per-process state 由模块单例承担）
  },
  unlock(s: Session): void {
    current = s;
  },
  lock(): void {
    current = null;
  },
  requireEnterprise(): Session {
    if (!current) throw new Error('not logged in');
    return current;
  },
  current(): Session | null {
    return current;
  },
};