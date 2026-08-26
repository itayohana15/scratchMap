import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="glass-panel mx-auto mt-16 flex max-w-md flex-col items-center gap-4 px-6 py-14 text-center">
      <h1 className="font-heading text-2xl font-semibold">הדף לא נמצא</h1>
      <p className="text-sm text-muted-foreground">הדף שחיפשתם לא קיים.</p>
      <Button nativeButton={false} render={<Link href="/dashboard" />}>
        חזרה לדף הבית
      </Button>
    </div>
  );
}
