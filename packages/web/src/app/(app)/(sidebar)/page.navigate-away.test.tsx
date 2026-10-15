// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

// Leaving the home composer at any point of a send must neither lose the
// prompt nor leave an empty session behind (#2336). The fake control plane
// models the semantics these cases turn on:
// - create completes even when the browser stops listening;
// - discard-draft only removes a session that never received a prompt;
// - a prompt into a removed session is rejected.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readStoredPromptDraft } from "@/lib/prompt-drafts";
import { mocks } from "./page.test-fixture";
import Home from "./page";

type ServerSession = { prompts: string[]; discarded: boolean };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function fakeControlPlane(
  options: {
    holdCreate?: boolean;
    holdPrompt?: boolean;
    holdPromptResponse?: boolean;
    rejectPrompt?: number;
  } = {}
) {
  const sessions = new Map<string, ServerSession>();
  const createGate = gate();
  const promptGate = gate();
  const log: string[] = [];
  let created = 0;

  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/sessions" && init?.method === "POST") {
      const id = `session-${++created}`;
      if (options.holdCreate) await createGate.opened;
      sessions.set(id, { prompts: [], discarded: false });
      log.push(`created ${id}`);
      // A real fetch rejects once aborted, whatever the server went on to do.
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return Response.json({ sessionId: id, status: "created" }, { status: 201 });
    }
    const prompt = url.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
    if (prompt) {
      const id = prompt[1];
      if (options.holdPrompt) await promptGate.opened;
      const session = sessions.get(id);
      if (!session || session.discarded) {
        log.push(`prompt rejected ${id}`);
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (options.rejectPrompt) {
        log.push(`prompt failed ${id}`);
        return Response.json({ error: "Upstream unavailable" }, { status: options.rejectPrompt });
      }
      session.prompts.push(JSON.parse(String(init?.body)).content);
      log.push(`prompt queued ${id}`);
      if (options.holdPromptResponse) await promptGate.opened;
      return Response.json({ messageId: "m1", status: "queued" });
    }
    const discard = url.match(/^\/api\/sessions\/([^/]+)\/discard-draft$/);
    if (discard) {
      const session = sessions.get(discard[1])!;
      if (session.prompts.length > 0) {
        log.push(`discard declined ${discard[1]}`);
        return Response.json({ outcome: "not_draft" });
      }
      session.discarded = true;
      log.push(`discarded ${discard[1]}`);
      return Response.json({ outcome: "discarded" });
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  });

  /** Sessions a list would show: everything not discarded. */
  const remaining = () =>
    [...sessions.entries()]
      .filter(([, session]) => !session.discarded)
      .map(([id, session]) => ({ id, prompts: session.prompts }));

  return { log, createGate, promptGate, remaining };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const composer = () => screen.getByPlaceholderText("What do you want to build?");

function typePrompt(text = "Fix the flaky test") {
  fireEvent.change(composer(), { target: { value: text } });
}

describe("Home: leaving mid-send (#2336)", () => {
  it("discards a draft whose creation finishes after the composer is gone", async () => {
    const server = fakeControlPlane({ holdCreate: true });
    const view = render(<Home />);
    typePrompt();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.anything()));

    view.unmount();
    server.createGate.open();
    await settle();
    await settle();

    expect(server.log).toEqual(["created session-1", "discarded session-1"]);
    expect(server.remaining()).toEqual([]);
  });

  it("delivers a prompt sent before its draft existed, even after leaving", async () => {
    const server = fakeControlPlane({ holdCreate: true });
    const view = render(<Home />);
    typePrompt();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await settle();

    view.unmount();
    server.createGate.open();
    await settle();
    await settle();

    expect(server.remaining()).toEqual([{ id: "session-1", prompts: ["Fix the flaky test"] }]);
    expect(server.log.some((entry) => entry.startsWith("discard"))).toBe(false);
  });

  it("does not discard the draft while its prompt is on the way", async () => {
    const server = fakeControlPlane({ holdPrompt: true });
    const view = render(<Home />);
    typePrompt();
    await waitFor(() => expect(server.log).toContain("created session-1"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/prompt", expect.anything())
    );

    view.unmount();
    await settle();
    server.promptGate.open();
    await settle();
    await settle();

    expect(server.log).toEqual(["created session-1", "prompt queued session-1"]);
    // No teardown request of any kind raced the send.
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "/api/sessions",
      "/api/sessions/session-1/prompt",
    ]);
  });

  it("does not pull the author back once they have left", async () => {
    const server = fakeControlPlane({ holdPromptResponse: true });
    const view = render(<Home />);
    typePrompt();
    await waitFor(() => expect(server.log).toContain("created session-1"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(server.log).toContain("prompt queued session-1"));

    view.unmount();
    server.promptGate.open();
    await settle();
    await settle();

    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Session started",
      expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) })
    );
  });

  it("does not offer the in-flight prompt to a composer opened meanwhile", async () => {
    const server = fakeControlPlane({ holdPromptResponse: true });
    const first = render(<Home />);
    typePrompt();
    await waitFor(() => expect(server.log).toContain("created session-1"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(server.log).toContain("prompt queued session-1"));

    // The author leaves and comes back to Home before the send is confirmed.
    first.unmount();
    render(<Home />);
    await settle();

    expect(composer()).toHaveValue("");
    server.promptGate.open();
    await settle();
  });

  it("hands a failed send back: the text stays stored and the draft is reused", async () => {
    const server = fakeControlPlane({ rejectPrompt: 503 });
    render(<Home />);
    typePrompt();
    await waitFor(() => expect(server.log).toContain("created session-1"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(server.log).toContain("prompt failed session-1"));
    await settle();

    expect(composer()).toHaveValue("Fix the flaky test");
    expect(readStoredPromptDraft(`open-inspect-prompt-draft:${mocks.userId}:new-session`)).toEqual({
      prompt: "Fix the flaky test",
      pendingRequest: null,
    });

    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(server.log.filter((e) => e.startsWith("prompt")).length).toBe(2));
    // The retry goes into the same draft rather than warming another one.
    expect(server.log.filter((entry) => entry.startsWith("created"))).toEqual([
      "created session-1",
    ]);
    expect(server.log.some((entry) => entry.startsWith("discard"))).toBe(false);
  });
});
