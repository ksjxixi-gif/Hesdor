"use client";

import { Files } from "lucide-react";
import { ModulePlaceholder } from "@/components/shared/module-placeholder";

export default function FilesPage() {
  return <ModulePlaceholder icon={Files} eyebrow="Files" title="Company and employee files" description="Keep contracts, certificates, IDs, and company records permission-aware and close to the people they belong to." permission="files.read" recordsLabel="Files" />;
}
