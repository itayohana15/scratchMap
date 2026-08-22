"use client";

import { RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { usePreferenceProfile, useResetInferredProfile, useSetLearningEnabled } from "@/lib/queries/preference-profile";

export function PersonalizationSettingsSection() {
  const { data: profile, isLoading } = usePreferenceProfile();
  const setLearningEnabled = useSetLearningEnabled();
  const resetInferred = useResetInferredProfile();

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">פרטיות ולמידה</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            שליטה בלמידה מהתנהגות הטיולים שלך והעדפות שנלמדו.
          </p>
        </div>
      </div>

      {isLoading || !profile ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">למידה מהטיולים שלי</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                כשמופעל, המערכת מזהה דפוסים מטיולים שהושלמו ומציעה עדכוני העדפות. ההעדפות המפורשות שלך אף פעם לא משתנות באופן אוטומטי.
              </p>
            </div>
            <Switch
              checked={profile.learning_enabled}
              onCheckedChange={(checked) => setLearningEnabled.mutate(checked)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">אפס העדפות שנלמדו</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                מוחק רק את ההעדפות שנלמדו והצעות שנדחו. הטיולים, היומן והתמונות שלך לא נפגעים.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
                <RotateCcw className="size-4" />
                איפוס
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>לאפס את ההעדפות שנלמדו?</AlertDialogTitle>
                  <AlertDialogDescription>
                    פעולה זו מוחקת את ההעדפות שהמערכת למדה ואת ההצעות שנדחו. ההעדפות המפורשות שהגדרת, הטיולים, היומן והתמונות שלך יישארו ללא שינוי.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>ביטול</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      await resetInferred.mutateAsync();
                      toast.success("ההעדפות שנלמדו אופסו");
                    }}
                  >
                    איפוס
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
    </section>
  );
}
