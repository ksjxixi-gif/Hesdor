"use client";

import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth/auth-provider";

export type PermissionCode =
  | "employees.read"
  | "employees.manage"
  | "roles.manage"
  | "access.policy.manage"
  | "access.credential.issue"
  | "access.credential.revoke"
  | "access.door.unlock_remote"
  | "attendance.read"
  | "attendance.edit"
  | "tasks.manage"
  | "audit.read"
  | "messages.read"
  | "files.read"
  | "reports.read"
  | "settings.manage"
  | "organization.manage";

export function useHasPermission(permission: PermissionCode) {
  const { user } = useAuth();
  return Boolean(user?.permissions?.includes(permission));
}

export function Can({ permission, children, fallback = null }: { permission: PermissionCode; children: ReactNode; fallback?: ReactNode }) {
  return useHasPermission(permission) ? children : fallback;
}
