// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { OpencodePluginsSection } from "./opencode-plugins-section";
expect.extend(matchers);
afterEach(cleanup);
it("shows the latest boot's loaded and skipped plugins", async () => {
  const events: SandboxEvent[] = [
    {
      type: "opencode_plugins",
      sandboxId: "old",
      timestamp: 1,
      plugins: [{ spec: "removed@1.0.0", status: "loaded" }],
    },
    {
      type: "opencode_plugins",
      sandboxId: "new",
      timestamp: 2,
      plugins: [
        { spec: "audit@1.0.0", status: "loaded" },
        { spec: "broken@1.0.0", status: "skipped" },
      ],
    },
  ];
  render(<OpencodePluginsSection events={events} />);
  await userEvent.setup().click(screen.getByText("OpenCode plugins (1 loaded)"));
  expect(screen.getByText("audit@1.0.0")).toBeInTheDocument();
  expect(screen.getByText("Skipped — see session warnings")).toBeInTheDocument();
  expect(screen.queryByText("removed@1.0.0")).not.toBeInTheDocument();
});
it("clears a previous boot's plugin list when none are configured", () => {
  const { container } = render(
    <OpencodePluginsSection
      events={[{ type: "opencode_plugins", sandboxId: "new", timestamp: 2, plugins: [] }]}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
it("uses the boot sequence when equal-timestamp snapshots arrive out of order", () => {
  render(
    <OpencodePluginsSection
      events={[
        {
          type: "opencode_plugins",
          sandboxId: "new",
          timestamp: 2,
          bootSeq: 12,
          plugins: [{ spec: "audit@1.0.0", status: "loaded" }],
        },
        {
          type: "opencode_plugins",
          sandboxId: "new",
          timestamp: 2,
          bootSeq: 11,
          plugins: [{ spec: "audit@1.0.0", status: "pending" }],
        },
      ]}
    />
  );
  expect(screen.getByText("OpenCode plugins (1 loaded)")).toBeInTheDocument();
});
