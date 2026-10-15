"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, type ComponentProps } from "react";
import { useRepositoryHome } from "@/hooks/use-repository-home";

export function repositoryHomeHref(href: string, repoFullName: string | null): string {
  if (repoFullName === null) return href;
  const url = new URL(href, "https://repository-home.local");
  url.searchParams.set("homeRepo", repoFullName);
  return `${url.pathname}${url.search}${url.hash}`;
}

function useRepositoryHomeHref() {
  const { repoFullName } = useRepositoryHome();
  return useCallback((href: string) => repositoryHomeHref(href, repoFullName), [repoFullName]);
}

/** Apply ambient home scope at navigation, leaving destination builders scope-free. */
export function RepositoryHomeLink(
  props: Omit<ComponentProps<typeof Link>, "href"> & { href: string }
) {
  const scopedHref = useRepositoryHomeHref();
  return <Link {...props} href={scopedHref(props.href)} />;
}

export function useRepositoryHomeRouter() {
  const router = useRouter();
  const scopedHref = useRepositoryHomeHref();
  const push = useCallback(
    (href: string, options?: Parameters<typeof router.push>[1]) => {
      if (options) router.push(scopedHref(href), options);
      else router.push(scopedHref(href));
    },
    [router, scopedHref]
  );
  const replace = useCallback(
    (href: string, options?: Parameters<typeof router.replace>[1]) => {
      if (options) router.replace(scopedHref(href), options);
      else router.replace(scopedHref(href));
    },
    [router, scopedHref]
  );
  return useMemo(() => ({ ...router, push, replace }), [router, push, replace]);
}
