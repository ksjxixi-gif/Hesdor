"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, LayoutGrid, Pencil, Plus, SlidersHorizontal } from "lucide-react";
import { plansApi, type AdminPlan } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/table";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SkeletonRows } from "@/components/ui/skeleton";

const ALL_FEATURES = ["AccessControl", "Attendance", "Work", "Messaging", "Files", "AdvancedReports", "VisitorManagement", "Audit"] as const;
const ALL_LIMITS = ["MaxEmployees", "MaxLocations", "MaxDoors", "MaxActiveCredentials", "StorageBytes", "AuditRetentionDays"] as const;

const FEATURE_LABELS: Record<string, string> = {
  AccessControl: "Access control",
  Attendance: "Attendance",
  Work: "Work management",
  Messaging: "Messaging",
  Files: "Files",
  AdvancedReports: "Advanced reports",
  VisitorManagement: "Visitor management",
  Audit: "Audit",
};

const LIMIT_LABELS: Record<string, string> = {
  MaxEmployees: "Max employees",
  MaxLocations: "Max locations",
  MaxDoors: "Max doors",
  MaxActiveCredentials: "Max active credentials",
  StorageBytes: "Storage (bytes)",
  AuditRetentionDays: "Audit retention (days)",
};

type PlanFormState = {
  code: string;
  name: string;
  monthlyPrice: string;
  annualPrice: string;
  currencyCode: string;
  isActive: boolean;
  features: Set<string>;
  limits: Record<string, string>;
};

function toFormState(plan?: AdminPlan): PlanFormState {
  return {
    code: plan?.code ?? "",
    name: plan?.name ?? "",
    monthlyPrice: plan ? String(plan.monthlyPrice) : "",
    annualPrice: plan ? String(plan.annualPrice) : "",
    currencyCode: plan?.currencyCode ?? "USD",
    isActive: plan?.isActive ?? true,
    features: new Set(plan?.features ?? []),
    limits: Object.fromEntries(ALL_LIMITS.map((limit) => [limit, plan?.limits[limit]?.toString() ?? ""])),
  };
}

export function PlansScreen() {
  const { session, user } = useAuth();
  const queryClient = useQueryClient();
  const token = session?.accessToken ?? "";

  const plansQuery = useQuery({ queryKey: ["admin-plans"], queryFn: () => plansApi.list(token), enabled: Boolean(session && user?.isPlatform) });

  const [editorPlan, setEditorPlan] = useState<AdminPlan | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PlanFormState>(toFormState());
  const [formError, setFormError] = useState<string | null>(null);

  const dialogOpen = creating || editorPlan !== null;

  const openCreate = () => {
    setForm(toFormState());
    setFormError(null);
    setCreating(true);
    setEditorPlan(null);
  };

  const openEdit = (plan: AdminPlan) => {
    setForm(toFormState(plan));
    setFormError(null);
    setEditorPlan(plan);
    setCreating(false);
  };

  const closeDialog = () => {
    setCreating(false);
    setEditorPlan(null);
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-plans"] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const features = [...form.features];
      const limits = Object.fromEntries(Object.entries(form.limits).filter(([, value]) => value !== "").map(([key, value]) => [key, Number(value)]));
      const monthlyPrice = Number(form.monthlyPrice);
      const annualPrice = Number(form.annualPrice);
      if (editorPlan) {
        await plansApi.update(token, editorPlan.id, { name: form.name, monthlyPrice, annualPrice, currencyCode: form.currencyCode, isActive: form.isActive });
        await plansApi.updateDetails(token, editorPlan.id, { features, limits });
      } else {
        await plansApi.create(token, { code: form.code, name: form.name, monthlyPrice, annualPrice, currencyCode: form.currencyCode, isActive: form.isActive, features, limits });
      }
    },
    onSuccess: () => {
      invalidate();
      closeDialog();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : "Failed to save plan."),
  });

  const deactivateMutation = useMutation({
    mutationFn: (planId: string) => plansApi.deactivate(token, planId),
    onSuccess: invalidate,
  });

  const columns = useMemo<Column<AdminPlan>[]>(() => [
    {
      header: "Plan",
      render: (plan) => (
        <div>
          <p className="font-semibold text-text">{plan.name}</p>
          <p className="font-mono text-xs text-text-faint">{plan.code}</p>
        </div>
      ),
    },
    {
      header: "Monthly",
      className: "text-right",
      render: (plan) => <span className="tnum font-semibold">{plan.monthlyPrice} {plan.currencyCode}</span>,
    },
    {
      header: "Annual",
      className: "text-right",
      render: (plan) => <span className="tnum text-text-muted">{plan.annualPrice} {plan.currencyCode}</span>,
    },
    {
      header: "Features",
      render: (plan) => <span className="text-xs text-text-muted">{plan.features.length ? plan.features.map((f) => FEATURE_LABELS[f] ?? f).join(", ") : "None"}</span>,
    },
    {
      header: "Status",
      render: (plan) => <Badge tone={plan.isActive ? "green" : "neutral"}>{plan.isActive ? "Active" : "Inactive"}</Badge>,
    },
    {
      header: "",
      className: "text-right",
      render: (plan) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEdit(plan)} aria-label={`Edit ${plan.name}`}>
            <Pencil size={14} />
          </Button>
          {plan.isActive ? (
            <Button variant="ghost" size="sm" onClick={() => deactivateMutation.mutate(plan.id)} aria-label={`Deactivate ${plan.name}`} className="hover:text-red">
              <Ban size={14} />
            </Button>
          ) : null}
        </div>
      ),
    },
  ], [deactivateMutation]);

  if (!user?.isPlatform) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState icon={LayoutGrid} title="Platform team only" description="Plan administration is restricted to the Hesdor platform workspace." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Platform"
        title="Plans"
        description="Define what customers can buy: prices, features, and limits. Changes apply to tenants immediately."
        actions={<Button onClick={openCreate}><Plus size={15} /> New plan</Button>}
      />

      <Card className="mt-8">
        <CardContent className="p-0">
          {plansQuery.isPending ? (
            <div className="p-5"><SkeletonRows rows={4} /></div>
          ) : plansQuery.data?.length ? (
            <DataTable columns={columns} rows={plansQuery.data} keyOf={(plan) => plan.id} />
          ) : (
            <EmptyState icon={LayoutGrid} title="No plans yet" description="Create your first plan to start selling." actionLabel="New plan" onAction={openCreate} />
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        wide
        title={editorPlan ? `Edit ${editorPlan.name}` : "New plan"}
        description={editorPlan ? "Update pricing, features, and limits. Applies tenant-wide immediately." : "Create a plan customers can subscribe to."}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" hint="Lowercase identifier, e.g. starter">
            <Input value={form.code} disabled={Boolean(editorPlan)} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="starter" />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Starter" />
          </Field>
          <Field label="Monthly price">
            <Input type="number" min={0} step="0.01" value={form.monthlyPrice} onChange={(event) => setForm({ ...form, monthlyPrice: event.target.value })} />
          </Field>
          <Field label="Annual price">
            <Input type="number" min={0} step="0.01" value={form.annualPrice} onChange={(event) => setForm({ ...form, annualPrice: event.target.value })} />
          </Field>
          <Field label="Currency">
            <Select value={form.currencyCode} onChange={(event) => setForm({ ...form, currencyCode: event.target.value })}>
              <option value="USD">USD</option>
              <option value="JOD">JOD</option>
              <option value="EUR">EUR</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={form.isActive ? "active" : "inactive"} onChange={(event) => setForm({ ...form, isActive: event.target.value === "active" })}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </Field>
        </div>

        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold text-text-muted">Features</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ALL_FEATURES.map((feature) => (
              <label key={feature} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 transition hover:bg-elevated">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={form.features.has(feature)}
                  onChange={(event) => {
                    const next = new Set(form.features);
                    if (event.target.checked) next.add(feature);
                    else next.delete(feature);
                    setForm({ ...form, features: next });
                  }}
                />
                <span className="text-sm text-text">{FEATURE_LABELS[feature]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-muted"><SlidersHorizontal size={13} /> Limits (blank = unset, -1 = unlimited)</p>
          <div className="grid gap-4 sm:grid-cols-3">
            {ALL_LIMITS.map((limit) => (
              <Field key={limit} label={LIMIT_LABELS[limit]}>
                <Input
                  type="number"
                  value={form.limits[limit]}
                  onChange={(event) => setForm({ ...form, limits: { ...form.limits, [limit]: event.target.value } })}
                />
              </Field>
            ))}
          </div>
        </div>

        {formError ? <p className="mt-4 rounded-lg border border-red/30 bg-red-soft px-3 py-2 text-sm text-red">{formError}</p> : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={closeDialog}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !form.name || !form.code || !form.monthlyPrice}>
            {saveMutation.isPending ? "Saving…" : editorPlan ? "Save changes" : "Create plan"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
