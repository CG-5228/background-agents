import { useEffect } from "react";
import { markPageLoadMilestone, type PageLoadMilestone } from "@/lib/page-load-telemetry";

export function usePageLoadMilestone(name: PageLoadMilestone, reached: boolean): void {
  useEffect(() => {
    if (reached) markPageLoadMilestone(name);
  }, [name, reached]);
}
