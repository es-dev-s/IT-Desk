"use client";

import { ArrowLeftRight, LifeBuoy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useTransfers } from "@/store/selectors";
import { useRequests } from "@/store/requests-store";
import { Segmented } from "@/components/ui/segmented";

type Lane = "transfers" | "requests";

/** IT's two work queues side by side: seat transfers and equipment/support requests. */
export function ItQueueSwitch({ value }: { value: Lane }) {
  const router = useRouter();
  const transfers = useTransfers();
  const counts = useRequests((s) => s.counts);
  const openTransfers = useMemo(() => transfers.filter((t) => t.itStatus !== "completed").length, [transfers]);
  return (
    <Segmented
      size="md"
      collapseLabels={false}
      label="IT queue"
      value={value}
      onChange={(v) => router.push(v === "transfers" ? "/queue" : "/requests")}
      options={[
        { value: "transfers", label: "Transfers", icon: ArrowLeftRight, count: openTransfers },
        { value: "requests", label: "Requests", icon: LifeBuoy, count: counts ? counts.open + counts.inProgress : undefined },
      ]}
    />
  );
}
