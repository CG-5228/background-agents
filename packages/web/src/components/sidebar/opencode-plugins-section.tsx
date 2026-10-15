import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { CollapsibleSection } from "./collapsible-section";

export function OpencodePluginsSection({ events }: { events: readonly SandboxEvent[] }) {
  let latest: Extract<SandboxEvent, { type: "opencode_plugins" }> | undefined;
  for (const event of events) {
    if (event.type !== "opencode_plugins") continue;
    if (
      !latest ||
      event.timestamp > latest.timestamp ||
      (event.timestamp === latest.timestamp && (event.bootSeq ?? 0) >= (latest.bootSeq ?? 0))
    ) {
      latest = event;
    }
  }
  if (!latest || latest.plugins.length === 0) return null;
  return (
    <CollapsibleSection
      title={`OpenCode plugins (${latest.plugins.filter((plugin) => plugin.status === "loaded").length} loaded)`}
      defaultOpen={false}
    >
      <div className="space-y-2">
        {latest.plugins.map((plugin) => (
          <div key={plugin.spec} className="space-y-1">
            <p className="break-all font-mono text-xs text-foreground">{plugin.spec}</p>
            <p className="text-xs text-muted-foreground">
              {plugin.status === "pending"
                ? "Loading"
                : plugin.status === "loaded"
                  ? "Loaded"
                  : "Skipped — see session warnings"}
            </p>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
