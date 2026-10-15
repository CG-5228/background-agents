import { z } from "zod";
import type { PromptRequestIdentity } from "@/lib/prompt-request-id";

const PROMPT_DRAFT_STORAGE_KEY_PREFIX = "open-inspect-prompt-draft:";

/** Draft ID for the new-session composer, which has no session ID yet. */
export const NEW_SESSION_PROMPT_DRAFT_ID = "new-session";

/**
 * A draft and the identity of its unconfirmed send, stored as one record so a
 * restored draft never loses the idempotency key of a send that may have landed.
 */
export type StoredPromptDraft = {
  prompt: string;
  pendingRequest: PromptRequestIdentity | null;
  /**
   * The prompt was submitted and its outcome is not known yet. It stays stored
   * so a reload mid-send can offer it again; a composer mounted while the send
   * is still running in this page leaves it out instead.
   */
  sending?: true;
};

const storedPromptDraftSchema = z.object({
  prompt: z.string().min(1),
  pendingRequest: z.object({ signature: z.string(), clientRequestId: z.string() }).nullable(),
  sending: z.literal(true).optional(),
});

const sendsInFlight = new Set<string>();
const draftListeners = new Map<string, Set<() => void>>();

/** Records that this page is sending the draft stored under `key`. */
export function beginPromptDraftSend(key: string): void {
  sendsInFlight.add(key);
}

/** Ends a send and lets composers on `key` pick up a draft it handed back. */
export function endPromptDraftSend(key: string): void {
  sendsInFlight.delete(key);
  draftListeners.get(key)?.forEach((listener) => listener());
}

/** Whether a send of `key`'s draft is still running in this page; false after a reload. */
export function isPromptDraftSendInFlight(key: string): boolean {
  return sendsInFlight.has(key);
}

export function subscribeToPromptDraft(key: string, listener: () => void): () => void {
  const listeners = draftListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  draftListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(key);
  };
}

export function promptDraftStorageKey(userId: string, draftId: string): string {
  return `${PROMPT_DRAFT_STORAGE_KEY_PREFIX}${userId}:${draftId}`;
}

export function readStoredPromptDraft(key: string): StoredPromptDraft | null {
  try {
    const value = sessionStorage.getItem(key);
    if (value === null) return null;
    const parsed = storedPromptDraftSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes or removes a draft. An empty prompt removes it, and a failed write
 * drops the stale record so an outdated draft is never restored.
 */
export function writeStoredPromptDraft(key: string, draft: StoredPromptDraft | null): void {
  try {
    if (draft?.prompt) {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage is unavailable; the draft lives only in memory.
    }
  }
}

/** Removes this tab's stored drafts so prompt text does not outlive the signed-in account. */
export function clearStoredPromptDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PROMPT_DRAFT_STORAGE_KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Storage is unavailable, so there are no drafts to clear.
  }
}
