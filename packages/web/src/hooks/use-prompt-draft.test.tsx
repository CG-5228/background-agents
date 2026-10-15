// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPromptDraftSend,
  endPromptDraftSend,
  promptDraftStorageKey,
  readStoredPromptDraft,
  writeStoredPromptDraft,
} from "@/lib/prompt-drafts";
import { usePromptDraft } from "./use-prompt-draft";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

const KEY = promptDraftStorageKey("user-1", "new-session");

afterEach(() => {
  cleanup();
  endPromptDraftSend(KEY);
  sessionStorage.clear();
});

describe("usePromptDraft sends", () => {
  it("keeps a submitted prompt stored, marked as sending, until its outcome is known", () => {
    const { result } = renderHook(() => usePromptDraft("new-session"));
    act(() => result.current.setPrompt("Fix the flaky test"));

    act(() => result.current.markPromptSending("Fix the flaky test"));

    expect(readStoredPromptDraft(KEY)).toEqual({
      prompt: "Fix the flaky test",
      pendingRequest: null,
      sending: true,
    });
  });

  it("offers a prompt again after a reload interrupted its send", () => {
    // What a reload leaves behind: the record, but no send running in this page.
    writeStoredPromptDraft(KEY, {
      prompt: "Fix the flaky test",
      pendingRequest: null,
      sending: true,
    });

    const { result } = renderHook(() => usePromptDraft("new-session"));

    expect(result.current.prompt).toBe("Fix the flaky test");
    expect(readStoredPromptDraft(KEY)).toEqual({
      prompt: "Fix the flaky test",
      pendingRequest: null,
    });
  });

  it("leaves out a prompt another composer in this page is still sending", () => {
    writeStoredPromptDraft(KEY, {
      prompt: "Fix the flaky test",
      pendingRequest: null,
      sending: true,
    });
    beginPromptDraftSend(KEY);

    const { result } = renderHook(() => usePromptDraft("new-session"));

    expect(result.current.prompt).toBe("");
  });

  it("shows a prompt handed back by a failed send in an empty composer mounted meanwhile", () => {
    const sender = renderHook(() => usePromptDraft("new-session"));
    act(() => sender.result.current.setPrompt("Fix the flaky test"));
    act(() => sender.result.current.markPromptSending("Fix the flaky test"));
    const { restoreUnsentPrompt } = sender.result.current;
    sender.unmount();
    const returned = renderHook(() => usePromptDraft("new-session"));
    expect(returned.result.current.prompt).toBe("");

    act(() => restoreUnsentPrompt("Fix the flaky test"));

    expect(returned.result.current.prompt).toBe("Fix the flaky test");
    expect(readStoredPromptDraft(KEY)).toEqual({
      prompt: "Fix the flaky test",
      pendingRequest: null,
    });
  });

  it("does not replace newer text with a prompt handed back by a failed send", () => {
    const sender = renderHook(() => usePromptDraft("new-session"));
    act(() => sender.result.current.setPrompt("Fix the flaky test"));
    act(() => sender.result.current.markPromptSending("Fix the flaky test"));
    const { restoreUnsentPrompt } = sender.result.current;
    sender.unmount();
    const returned = renderHook(() => usePromptDraft("new-session"));
    act(() => returned.result.current.setPrompt("Something else"));

    act(() => restoreUnsentPrompt("Fix the flaky test"));

    expect(returned.result.current.prompt).toBe("Something else");
    expect(readStoredPromptDraft(KEY)?.prompt).toBe("Something else");
  });

  it("clears a prompt whose send succeeded", () => {
    const { result } = renderHook(() => usePromptDraft("new-session"));
    act(() => result.current.setPrompt("Fix the flaky test"));
    act(() => result.current.markPromptSending("Fix the flaky test"));

    act(() => result.current.clearSubmittedPrompt("Fix the flaky test"));

    expect(result.current.prompt).toBe("");
    expect(readStoredPromptDraft(KEY)).toBeNull();
  });
});
