import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="flex min-h-screen w-full flex-col">
      <div className="flex min-h-full flex-col">
        <div className="relative">
          <Skeleton className="h-[22rem] w-full rounded-none sm:h-[26rem] lg:h-[30rem]" />

          <div className="relative z-20 -mt-7 w-full px-[3vw]">
            <Skeleton className="h-16 rounded-[1.75rem]" />
          </div>
        </div>

        <div className="flex w-full flex-col px-[3vw] pb-12">
          <div className="pt-10">
            <Skeleton className="h-80 rounded-[2rem]" />
          </div>
        </div>
      </div>
    </main>
  );
}
