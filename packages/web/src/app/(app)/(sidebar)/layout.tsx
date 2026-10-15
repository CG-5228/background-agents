import { Suspense } from "react";
import { RepositoryHomeProvider } from "@/hooks/use-repository-home";
import { SidebarLayout } from "@/components/sidebar-layout";
import { ActiveTeamProvider } from "@/hooks/use-active-team";

export default function SidebarAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ActiveTeamProvider>
      <Suspense fallback={null}>
        <RepositoryHomeProvider>
          <SidebarLayout>{children}</SidebarLayout>
        </RepositoryHomeProvider>
      </Suspense>
    </ActiveTeamProvider>
  );
}
