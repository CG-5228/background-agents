import useSWR from "swr";
import { providerAccountUsageResponseSchema } from "@open-inspect/shared/types/provider-account-usage";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export function useProviderAccountUsage(accountId: string, updatedAt: number, enabled: boolean) {
  const { hasPermission } = useCurrentUserAuthorization();
  return useSWR(
    enabled && hasPermission("provider_accounts.read")
      ? ([`/api/model-provider-accounts/${accountId}/usage` as BrowserApiPath, updatedAt] as const)
      : null,
    async ([path]) => {
      const response = await browserApiFetch(path);
      if (!response.ok) throw new Error("Usage could not be loaded");
      return providerAccountUsageResponseSchema.parse(await response.json()).usage;
    },
    {
      // Explicit checks always reach the server, which owns quota/reset-window caching.
      dedupingInterval: 0,
      revalidateOnMount: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    }
  );
}
