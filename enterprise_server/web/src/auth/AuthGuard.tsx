import type { ReactNode } from 'react';
import type { JSX } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './useAuth';

interface Props {
  requires?: string;
  children: ReactNode;
}

export function AuthGuard({ requires, children }: Props): JSX.Element {
  const { token, hasCapability } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  if (requires && !hasCapability(requires)) return <Navigate to="/" replace />;
  return <>{children}</>;
}