"use client";

import { BarChart3 } from "lucide-react";
import { ModulePlaceholder } from "@/components/shared/module-placeholder";

export default function ReportsPage() {
  return <ModulePlaceholder icon={BarChart3} eyebrow="Reports" title="Operational intelligence" description="Turn attendance, access, work, and organization signals into reports teams can act on." permission="reports.read" recordsLabel="Reports" />;
}
