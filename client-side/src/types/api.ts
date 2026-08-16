import type { components } from "@/types/generated/api";

export type ApiSchemas = components["schemas"];

export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAtUtc: string;
  refreshTokenExpiresAtUtc?: string;
};

export type CurrentUser = {
  userId: string;
  tenantId: string;
  email: string | null;
  roles: string[];
  permissions: string[];
};

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  plan: ApiSchemas["TenantPlan"] | null;
  status: ApiSchemas["TenantStatus"] | null;
  timeZone: string | null;
  locale: string | null;
};

export type LoginResponse = ApiSchemas["LoginResponse"];

export type ApiErrorBody = {
  error?: string;
  title?: string;
  detail?: string;
  errors?: Record<string, string[]>;
};
