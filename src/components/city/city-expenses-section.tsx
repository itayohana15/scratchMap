"use client";

import { Plane, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDateRange } from "@/lib/format";
import { useTripCitiesForCity, useUpsertTrip, useUpsertTripCity } from "@/lib/queries/trips";

interface CityExpensesSectionProps {
  cityId: string;
}

export function CityExpensesSection({ cityId }: CityExpensesSectionProps) {
  const { data: visits, isLoading } = useTripCitiesForCity(cityId);
  const upsertTrip = useUpsertTrip();
  const upsertTripCity = useUpsertTripCity();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [arrival, setArrival] = useState("");
  const [departure, setDeparture] = useState("");

  const saving = upsertTrip.isPending || upsertTripCity.isPending;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const trip = await upsertTrip.mutateAsync({
        name: name.trim(),
        cost: cost ? Number(cost) : null,
        start_date: arrival || null,
        end_date: departure || null,
      });
      await upsertTripCity.mutateAsync({
        trip_id: trip.id,
        city_id: cityId,
        arrival_date: arrival || null,
        departure_date: departure || null,
      });
      setName("");
      setCost("");
      setArrival("");
      setDeparture("");
      setShowForm(false);
    } catch {
      toast.error("הוספת הטיול נכשלה");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">הוצאות</h2>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setShowForm((s) => !s)}>
          <Plus className="size-4" />
          הוספת טיול
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="glass-card grid gap-2 p-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs text-muted-foreground">שם הטיול</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">הגעה</label>
            <Input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">יציאה</label>
            <Input type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs text-muted-foreground">עלות</label>
            <Input type="number" step="any" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={saving} className="sm:col-span-2">
            שמירה
          </Button>
        </form>
      )}

      {isLoading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : visits && visits.length > 0 ? (
        <ul className="space-y-2">
          {visits.map((visit) => (
            <li key={visit.id} className="glass-card flex items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <Plane className="size-4 text-primary" />
                <div>
                  <p className="text-sm font-medium">{visit.trips.name}</p>
                  {formatDateRange(visit.arrival_date, visit.departure_date) && (
                    <p className="text-xs text-muted-foreground">
                      {formatDateRange(visit.arrival_date, visit.departure_date)}
                    </p>
                  )}
                </div>
              </div>
              {visit.trips.cost != null && (
                <span className="text-sm font-medium">{formatCurrency(visit.trips.cost)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="glass-card px-4 py-8 text-center text-sm text-muted-foreground">
          לא נרשמו טיולים לעיר הזו עדיין.
        </div>
      )}
    </section>
  );
}
