"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createSessionResponseSchema } from "@open-inspect/shared/types/session-api";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type { SessionTargetRequestFields } from "@/lib/session-target";
import { discardWarmDraftSession } from "@/lib/warm-session";
import type { InteractiveProviderRoutingIdentity } from "@/lib/provider-selection";

export type WarmDraftSessionRequest = SessionTargetRequestFields & {
  harness: HarnessId;
  model: string;
  reasoningEffort?: string;
  skillSelection: SessionSkillSelection;
  includePersonalMemories?: boolean;
  providerSelections: ModelProviderSelections;
  teamId: string | null;
  visibility: SessionVisibility;
};

interface WarmDraftSessionError {
  message: string;
  code: string | null;
  status: number;
  terminal: boolean;
}

/**
 * What a warm draft is bound to. Of the model only its provider counts: every
 * prompt carries its own model and effort, and the first one sets the
 * session's, so switching between one provider's models while typing keeps the
 * draft (and its booting sandbox). The provider stays because create checks it
 * against the harness and the provider's auth mode, and a new provider is how a
 * draft refused for those reasons gets another try.
 */
export function warmDraftSessionIdentity(
  request: WarmDraftSessionRequest | null,
  routingIdentity?: InteractiveProviderRoutingIdentity
): string | null {
  if (!request) return null;
  const { model, reasoningEffort: _reasoningEffort, ...launchTarget } = request;
  const modelProvider = model.slice(0, model.indexOf("/"));
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return JSON.stringify(
    canonicalize({ request: { ...launchTarget, modelProvider }, routingIdentity })
  );
}

/** What one creation attempt produced: a draft, or the reason there is none. */
export type WarmDraftResult =
  { sessionId: string; error: null } | { sessionId: null; error: WarmDraftSessionError | null };

/**
 * One creation attempt, from request to draft. Exactly one party owns it at a
 * time: the hook while it warms the composer's current launch, the submit that
 * claimed it, or nobody once its launch was superseded or the composer left.
 * Only a hook-owned attempt publishes state; an ownerless one discards the
 * draft it produces.
 */
interface WarmAttempt {
  owner: "hook" | "submit" | "none";
  result: Promise<WarmDraftResult>;
  /** Set once a hook-owned attempt has produced its draft. */
  sessionId: string | null;
}

async function createDraft(launchRequest: WarmDraftSessionRequest): Promise<WarmDraftResult> {
  try {
    const response = await browserApiFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(launchRequest),
    });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      let message = "Failed to create session";
      let code: string | null = null;
      if (failure && typeof failure === "object") {
        if ("error" in failure && typeof failure.error === "string") message = failure.error;
        if ("code" in failure && typeof failure.code === "string") code = failure.code;
        if (
          code === "target_team_missing_grant" &&
          "repository" in failure &&
          typeof failure.repository === "string"
        ) {
          message = `This team has no repository grant for ${failure.repository}.`;
        }
      }
      return {
        sessionId: null,
        error: {
          message: code ? `${message} (${code})` : message,
          code,
          status: response.status,
          // Grants can be restored without changing the draft's identity.
          terminal:
            code !== "target_team_missing_grant" && [400, 403, 404, 409].includes(response.status),
        },
      };
    }
    const parsed = createSessionResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? { sessionId: parsed.data.sessionId, error: null }
      : { sessionId: null, error: null };
  } catch (error) {
    console.error("Failed to create session for warming:", error);
    return { sessionId: null, error: null };
  }
}

/**
 * Keeps one draft session ready for the composer's current request.
 *
 * Creation is never aborted: the server finishes creating a draft whether or
 * not the browser is still listening, so an abort only loses track of it.
 * Instead each attempt carries its owner (see `WarmAttempt`). A request change
 * or unmount gives up the hook's attempt — discarding its draft now, or when
 * it arrives — and `claim` hands the attempt to a submit, which receives its
 * draft or its error. `release` takes back a claimed draft whose first prompt
 * was not sent.
 */
export function useWarmDraftSession(
  request: WarmDraftSessionRequest | null,
  routingIdentity?: InteractiveProviderRoutingIdentity
) {
  const identity = warmDraftSessionIdentity(request, routingIdentity);
  const requestRef = useRef(request);
  const identityRef = useRef(identity);
  const ownedRef = useRef<WarmAttempt | null>(null);
  const disposedRef = useRef(false);
  const errorRef = useRef<WarmDraftSessionError | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWarming, setIsWarming] = useState(false);
  const [error, setError] = useState<WarmDraftSessionError | null>(null);

  useLayoutEffect(() => {
    requestRef.current = request;
    identityRef.current = identity;
  }, [identity, request]);

  /** The hook stops owning its attempt; whatever draft it holds or will hold is discarded. */
  const abandonOwnedAttempt = useCallback(() => {
    const attempt = ownedRef.current;
    ownedRef.current = null;
    if (!attempt) return;
    attempt.owner = "none";
    if (attempt.sessionId) void discardWarmDraftSession(attempt.sessionId);
  }, []);

  useLayoutEffect(() => {
    abandonOwnedAttempt();
    setSessionId(null);
    setIsWarming(false);
    errorRef.current = null;
    setError(null);
  }, [abandonOwnedAttempt, identity]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      abandonOwnedAttempt();
    };
  }, [abandonOwnedAttempt]);

  /** Starts a hook-owned attempt for the current launch, or returns null when there is none. */
  const startAttempt = useCallback((): WarmAttempt | null => {
    const launchRequest = requestRef.current;
    if (!launchRequest || !identityRef.current) return null;

    const attempt: WarmAttempt = {
      owner: "hook",
      sessionId: null,
      result: Promise.resolve({ sessionId: null, error: null }),
    };
    attempt.result = createDraft(launchRequest).then((result) => {
      if (attempt.owner === "hook") {
        if (result.sessionId) {
          attempt.sessionId = result.sessionId;
          setSessionId(result.sessionId);
        } else {
          ownedRef.current = null;
          errorRef.current = result.error;
          setError(result.error);
        }
        setIsWarming(false);
      } else if (attempt.owner === "none" && result.sessionId) {
        void discardWarmDraftSession(result.sessionId);
      }
      return result;
    });

    ownedRef.current = attempt;
    setIsWarming(true);
    errorRef.current = null;
    setError(null);
    return attempt;
  }, []);

  const warm = useCallback(async (): Promise<string | null> => {
    const owned = ownedRef.current;
    if (owned) return owned.sessionId ?? (await owned.result).sessionId;
    if (errorRef.current?.terminal) return null;
    const attempt = startAttempt();
    return attempt ? (await attempt.result).sessionId : null;
  }, [startAttempt]);

  /** Takes ownership of the ready or warming draft, starting one if needed. */
  const claim = useCallback(async (): Promise<WarmDraftResult> => {
    const attempt = ownedRef.current ?? (errorRef.current?.terminal ? null : startAttempt());
    if (!attempt) return { sessionId: null, error: errorRef.current };
    ownedRef.current = null;
    attempt.owner = "submit";
    setSessionId(null);
    setIsWarming(false);
    return attempt.sessionId ? { sessionId: attempt.sessionId, error: null } : attempt.result;
  }, [startAttempt]);

  /**
   * Hands back a claimed draft whose send failed. A draft whose prompt was
   * `not_sent` becomes the hook's draft again while the composer still wants
   * that launch and holds no other. Anything else is discarded, including a
   * send whose delivery is `unknown`: reusing a session that may already hold
   * the prompt would put the next send into it. The discard is a no-op for a
   * session that did receive the prompt, so an ambiguous failure cannot lose
   * work.
   */
  const release = useCallback(
    (
      releasedSessionId: string,
      launchIdentity: string | null,
      delivery: "not_sent" | "unknown"
    ) => {
      if (
        delivery !== "not_sent" ||
        disposedRef.current ||
        launchIdentity !== identityRef.current ||
        ownedRef.current
      ) {
        void discardWarmDraftSession(releasedSessionId);
        return;
      }
      ownedRef.current = {
        owner: "hook",
        sessionId: releasedSessionId,
        result: Promise.resolve({ sessionId: releasedSessionId, error: null }),
      };
      setSessionId(releasedSessionId);
    },
    []
  );

  return { identity, sessionId, isWarming, warm, claim, release, error };
}
