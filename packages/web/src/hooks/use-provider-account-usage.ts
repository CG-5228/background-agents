import useSWR from "swr";
import {
  PROVIDER_ACCOUNT_USAGE_CACHE_MS,
  providerAccountUsageResponseSchema,
} from "@open-inspect/shared/types/provider-account-usage";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export function useProviderAccountUsage(accountId: string, enabled: boolean) {
  const { hasPermission } = useCurrentUserAuthorization();
  return useSWR(
    enabled && hasPermission("provider_accounts.read")
      ? (`/api/model-provider-accounts/${accountId}/usage` as BrowserApiPath)
      : null,
    async (path) => {
      const response = await browserApiFetch(path);
      if (!response.ok) throw new Error("Usage could not be loaded");
      return providerAccountUsageResponseSchema.parse(await response.json()).usage;
    },
    {
      dedupingInterval: PROVIDER_ACCOUNT_USAGE_CACHE_MS,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    }
  );
}
