"use client";

import { ShieldCheck } from "lucide-react";
import { ModulePlaceholder } from "@/components/shared/module-placeholder";

export default function AuditPage() {
  return <ModulePlaceholder icon={ShieldCheck} eyebrow="Audit" title="Searchable history" description="Trace actor, action, entity, date, and result across sensitive workplace operations." permission="audit.read" recordsLabel="Audit events" />;
}
