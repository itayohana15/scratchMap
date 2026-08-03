import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";

interface PlaceholderSectionProps {
  title: string;
  description: string;
  icon?: LucideIcon;
}

export function PlaceholderSection({
  title,
  description,
  icon: Icon = Sparkles,
}: PlaceholderSectionProps) {
  return (
    <div className="glass-card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground" />
      <h3 className="font-heading font-medium">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      <span className="mt-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
        יגיע בשלב מאוחר יותר
      </span>
    </div>
  );
}
