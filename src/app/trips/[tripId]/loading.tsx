import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1450px] space-y-4 px-4 py-4 sm:px-6">
      <Skeleton className="h-56 rounded-[28px] sm:h-64" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-2xl" />
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}
