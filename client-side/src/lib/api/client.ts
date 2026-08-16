import type { ApiErrorBody, ApiSchemas, CurrentUser, LoginResponse, Tenant } from "@/types/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5187";

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(message: string, status: number, body: ApiErrorBody | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type PagedResponse<T> = { items?: T[] | null; page?: number; pageSize?: number; totalCount?: number };
export type Project = { id: string; name: string; description?: string | null; status: number; createdByEmployeeId?: string | null; createdAtUtc: string; updatedAtUtc: string };
export type WorkTask = { id: string; projectId: string; parentTaskId?: string | null; title: string; description?: string | null; status: number; priority: number; dueAtUtc?: string | null; createdByEmployeeId?: string | null; createdAtUtc: string; updatedAtUtc: string };
export type Conversation = { id: string; type: number; scope: number; name?: string | null; lastMessageAtUtc?: string | null };
export type Message = { id: string; conversationId: string; senderUserId: string; senderEmployeeId?: string | null; content: string; replyToMessageId?: string | null; createdAtUtc: string; editedAtUtc?: string | null; isDeleted: boolean };
export type Announcement = { id: string; title: string; body: string; status: number; publishedAtUtc?: string | null; expiresAtUtc?: string | null; createdAtUtc: string };
export type EntitlementSnapshot = { tenantId: string; planCode: string; subscriptionStatus: number; currentPeriodEndUtc: string; enabledFeatures: number[]; limits: Record<string, number> };
export type Subscription = { id: string; planId: string; status: number; billingCycle: number; provider: number; startedAtUtc: string; currentPeriodStartUtc: string; currentPeriodEndUtc: string; trialEndsAtUtc?: string | null; gracePeriodEndsAtUtc?: string | null; cancelAtPeriodEnd: boolean; canceledAtUtc?: string | null };
export type AccessEvent = { id: string; credentialId?: string | null; employeeId?: string | null; doorId: string; decision: number; reason: string; source: number; occurredAtUtc: string };
export type AttendanceSession = { id: string; employeeId: string; workDate: string; sequence: number; clockInAtUtc?: string | null; clockOutAtUtc?: string | null; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; status: number; source: number };
export type Presence = { employeeId: string; state: number; locationId?: string | null; updatedAtUtc: string };
export type Role = { id: string; name: string; description?: string | null; isSystemRole: boolean; permissions: { code: string; isAllowed: boolean }[] };

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try { return await response.json(); } catch { return null; }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, accessToken?: string, options: { suppressSessionExpired?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("The Hesdor API is unreachable.", 0);
  }
  const body = await parseBody(response);
  if (!response.ok) {
    if (response.status === 401 && !options.suppressSessionExpired && typeof window !== "undefined") window.dispatchEvent(new Event("hesdor:session-expired"));
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(errorBody?.error ?? errorBody?.detail ?? errorBody?.title ?? `Request failed with status ${response.status}.`, response.status, errorBody);
  }
  return body as T;
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); });
  const result = query.toString();
  return result ? `?${result}` : "";
}

export const authApi = {
  async login(email: string, password: string) {
    const body: ApiSchemas["LoginRequest"] = { email, password };
    const data = await apiRequest<LoginResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(body) });
    if (!data.accessToken || !data.expiresAtUtc) throw new ApiError("The API returned an incomplete session.", 502);
    return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? "", expiresAtUtc: data.expiresAtUtc, refreshTokenExpiresAtUtc: data.refreshTokenExpiresAtUtc };
  },
  async refresh(refreshToken: string) {
    const body: ApiSchemas["RefreshRequest"] = { refreshToken };
    const data = await apiRequest<LoginResponse>("/api/auth/refresh", { method: "POST", body: JSON.stringify(body) }, undefined, { suppressSessionExpired: true });
    if (!data.accessToken || !data.expiresAtUtc) throw new ApiError("The API returned an incomplete refreshed session.", 502);
    return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? "", expiresAtUtc: data.expiresAtUtc, refreshTokenExpiresAtUtc: data.refreshTokenExpiresAtUtc };
  },
};

export const identityApi = {
  async me(accessToken: string) {
    const data = await apiRequest<ApiSchemas["CurrentUserResponse"] & { isPlatform?: boolean }>("/api/me", {}, accessToken);
    return { userId: data.userId ?? "", tenantId: data.tenantId ?? "", email: data.email ?? null, roles: data.roles ?? [], permissions: data.permissions ?? [], isPlatform: data.isPlatform ?? false } satisfies CurrentUser;
  },
};

export const organizationApi = {
  async current(accessToken: string) {
    const data = await apiRequest<ApiSchemas["TenantResponse"]>("/api/tenants/current", {}, accessToken);
    return { id: data.id ?? "", name: data.name ?? "", slug: data.slug ?? "", plan: data.plan ?? null, status: data.status ?? null, timeZone: data.timeZone ?? null, locale: data.locale ?? null } satisfies Tenant;
  },
};

export const employeeApi = {
  list(accessToken: string, params: { search?: string; page?: number; pageSize?: number } = {}) {
    return apiRequest<PagedResponse<{ id?: string; employeeNumber?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; jobTitle?: string | null; employmentStatus?: number; }>>(`/api/employees${queryString(params)}`, {}, accessToken);
  },
  create(accessToken: string, body: ApiSchemas["CreateEmployeeRequest"]) {
    return apiRequest<ApiSchemas["EmployeeListItemResponse"]>("/api/employees", { method: "POST", body: JSON.stringify(body) }, accessToken);
  },
};

export const projectApi = {
  list(accessToken: string) { return apiRequest<Project[]>("/api/projects", {}, accessToken); },
  create(accessToken: string, body: ApiSchemas["CreateProjectRequest"]) { return apiRequest<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }, accessToken); },
  update(accessToken: string, id: string, body: ApiSchemas["UpdateProjectRequest"]) { return apiRequest<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }, accessToken); },
};

export const taskApi = {
  list(accessToken: string, params: { projectId?: string; status?: number } = {}) { return apiRequest<WorkTask[]>(`/api/tasks${queryString(params)}`, {}, accessToken); },
  get(accessToken: string, id: string) { return apiRequest<{ task: WorkTask; assignees: { id: string; taskId: string; employeeId: string; createdAtUtc: string }[] }>(`/api/tasks/${id}`, {}, accessToken); },
  create(accessToken: string, body: ApiSchemas["CreateTaskRequest"]) { return apiRequest<WorkTask>("/api/tasks", { method: "POST", body: JSON.stringify(body) }, accessToken); },
  update(accessToken: string, id: string, body: ApiSchemas["UpdateTaskRequest"]) { return apiRequest<WorkTask>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }, accessToken); },
  comments(accessToken: string, id: string) { return apiRequest<{ id: string; taskId: string; authorEmployeeId: string; body: string; createdAtUtc: string; updatedAtUtc: string }[]>(`/api/tasks/${id}/comments`, {}, accessToken); },
  activity(accessToken: string, id: string) { return apiRequest<{ id: string; taskId: string; actorEmployeeId?: string | null; type: number; metadataJson?: string | null; createdAtUtc: string }[]>(`/api/tasks/${id}/activity`, {}, accessToken); },
};

export const accessApi = {
  doors(accessToken: string, search?: string) { return apiRequest<{ id: string; zoneId: string; name: string; code: string; type: number; status: number; affectsAttendance: boolean }[]>(`/api/access/doors${queryString({ search })}`, {}, accessToken); },
  events(accessToken: string, page = 1, pageSize = 20) { return apiRequest<{ items: AccessEvent[]; page: number; pageSize: number; totalCount: number }>(`/api/access/events${queryString({ page, pageSize })}`, {}, accessToken); },
  credentials(accessToken: string) { return apiRequest<unknown[]>("/api/access/credentials", {}, accessToken); },
};

export const roleApi = {
  list(accessToken: string) { return apiRequest<Role[]>("/api/roles", {}, accessToken); },
  permissions(accessToken: string) { return apiRequest<{ id: string; code: string; name: string; module: string; description?: string | null }[]>("/api/roles/permissions", {}, accessToken); },
};

export const attendanceApi = {
  sessions(accessToken: string, employeeId?: string) { return apiRequest<AttendanceSession[]>(`/api/attendance/sessions${queryString({ employeeId })}`, {}, accessToken); },
  presence(accessToken: string) { return apiRequest<Presence[]>("/api/attendance/presence", {}, accessToken); },
};

export const conversationApi = {
  list(accessToken: string) { return apiRequest<Conversation[]>("/api/conversations", {}, accessToken); },
  messages(accessToken: string, id: string, cursor?: string, pageSize = 50) { return apiRequest<{ items: Message[]; nextCursor?: string | null }>(`/api/conversations/${id}/messages${queryString({ cursor, pageSize })}`, {}, accessToken); },
  create(accessToken: string, body: ApiSchemas["CreateConversationRequest"]) { return apiRequest<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(body) }, accessToken); },
  send(accessToken: string, id: string, body: ApiSchemas["SendMessageRequest"]) { return apiRequest<Message>(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify(body) }, accessToken); },
  markRead(accessToken: string, id: string, body: ApiSchemas["MarkConversationReadRequest"]) { return apiRequest<unknown>(`/api/conversations/${id}/read`, { method: "POST", body: JSON.stringify(body) }, accessToken); },
};

export const announcementApi = {
  list(accessToken: string) { return apiRequest<Announcement[]>("/api/announcements", {}, accessToken); },
};

export const billingApi = {
  current(accessToken: string) { return apiRequest<{ subscription: Subscription | null; entitlements: EntitlementSnapshot | null }>("/api/billing/current", {}, accessToken); },
  entitlements(accessToken: string) { return apiRequest<EntitlementSnapshot>("/api/entitlements/current", {}, accessToken); },
  plans() { return apiRequest<{ id: string; code: string; name: string; monthlyPrice: number; annualPrice: number; currencyCode: string }[]>("/api/billing/plans"); },
};

export type AdminPlan = {
  id: string;
  code: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  currencyCode: string;
  isActive: boolean;
  features: string[];
  limits: Record<string, number>;
};

export const plansApi = {
  list(accessToken: string) { return apiRequest<AdminPlan[]>("/api/plans", {}, accessToken); },
  create(accessToken: string, body: { code: string; name: string; monthlyPrice: number; annualPrice: number; currencyCode?: string; isActive: boolean; features: string[]; limits: Record<string, number> }) {
    return apiRequest<AdminPlan>("/api/plans", { method: "POST", body: JSON.stringify(body) }, accessToken);
  },
  update(accessToken: string, id: string, body: { name?: string; monthlyPrice?: number; annualPrice?: number; currencyCode?: string; isActive?: boolean }) {
    return apiRequest<AdminPlan>(`/api/plans/${id}`, { method: "PUT", body: JSON.stringify(body) }, accessToken);
  },
  updateDetails(accessToken: string, id: string, body: { features?: string[]; limits?: Record<string, number> }) {
    return apiRequest<unknown>(`/api/plans/${id}/details`, { method: "PUT", body: JSON.stringify(body) }, accessToken);
  },
  deactivate(accessToken: string, id: string) {
    return apiRequest<unknown>(`/api/plans/${id}`, { method: "DELETE" }, accessToken);
  },
};

export function getApiBaseUrl() { return API_BASE_URL; }
