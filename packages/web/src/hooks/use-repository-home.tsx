"use client";

import { createContext, useContext } from "react";
import { useSearchParams } from "next/navigation";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";

const RepositoryHomeContext = createContext<string | null>(null);

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
  return { repoFullName, repository };
}
