"use client";

import { createContext, useCallback, useContext } from "react";
import { useSearchParams } from "next/navigation";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";

const RepositoryHomeContext = createContext<string | null>(null);

export function repositoryHomeHref(href: string, repoFullName: string | null): string {
  if (repoFullName === null) return href;
  const url = new URL(href, "https://repository-home.local");
  url.searchParams.set("homeRepo", repoFullName);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The URL carries this view's scope, including through session navigation and reloads. */
export function RepositoryHomeProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const repoFullName = searchParams.get("homeRepo")?.trim().toLowerCase() ?? null;
  return (
    <RepositoryHomeContext.Provider value={repoFullName}>{children}</RepositoryHomeContext.Provider>
  );
}

export function useRepositoryHome() {
  const repoFullName = useContext(RepositoryHomeContext);
  const repository = repoFullName === null ? null : parseRepositoryFullName(repoFullName);
  const scopedHref = useCallback(
    (href: string) => repositoryHomeHref(href, repoFullName),
    [repoFullName]
  );
  return { repoFullName, repository, scopedHref };
}
