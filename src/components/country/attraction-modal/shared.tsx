"use client";

import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ModalSection({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass-card animate-in fade-in space-y-3 p-4 duration-300 sm:p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="size-4 text-primary" />}
          <h3 className="text-base font-semibold">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function UnavailableRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium", value == null && "text-muted-foreground/70 italic")}>
        {value ?? "לא זמין"}
      </span>
    </div>
  );
}
