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

interface PendingCreation {
  promise: Promise<string | null>;
  /** A submit owns the result; the hook must not discard it. */
  claimed: boolean;
}

/**
 * Keeps one draft session ready for the composer's current request.
 *
 * Creation is never aborted: the server finishes creating a draft whether or
 * not the browser is still listening, so an abort only loses track of it. A
 * creation that resolves after its draft was superseded, or after the composer
 * unmounted, is discarded instead. A submit `claim`s the draft, after which
 * neither unmount nor a request change discards it; `release` hands back one
 * whose first prompt was not sent.
 */
export function useWarmDraftSession(
  request: WarmDraftSessionRequest | null,
  routingIdentity?: InteractiveProviderRoutingIdentity
) {
  const identity = warmDraftSessionIdentity(request, routingIdentity);
  const requestRef = useRef(request);
  const identityRef = useRef(identity);
  const sessionIdRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingCreation | null>(null);
  const disposedRef = useRef(false);
  const errorRef = useRef<WarmDraftSessionError | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWarming, setIsWarming] = useState(false);
  const [error, setError] = useState<WarmDraftSessionError | null>(null);

  useLayoutEffect(() => {
    requestRef.current = request;
    identityRef.current = identity;
  }, [identity, request]);

  useLayoutEffect(() => {
    pendingRef.current = null;
    setIsWarming(false);
    errorRef.current = null;
    setError(null);

    const supersededSessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionId(null);
    if (supersededSessionId) void discardWarmDraftSession(supersededSessionId);
  }, [identity]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const abandonedSessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (abandonedSessionId) void discardWarmDraftSession(abandonedSessionId);
    };
  }, []);

  const warm = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (pendingRef.current) return pendingRef.current.promise;
    if (errorRef.current?.terminal) return null;

    const launchRequest = requestRef.current;
    const launchIdentity = identityRef.current;
    if (!launchRequest || !launchIdentity) return null;

    setIsWarming(true);
    errorRef.current = null;
    setError(null);

    const pending: PendingCreation = { promise: Promise.resolve(null), claimed: false };
    const isCurrent = () => !disposedRef.current && identityRef.current === launchIdentity;

    pending.promise = (async () => {
      try {
        const response = await browserApiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(launchRequest),
        });
        if (!response.ok) {
          const failure: unknown = await response.json().catch(() => null);
          if (!pending.claimed && !isCurrent()) return null;
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
          const creationError: WarmDraftSessionError = {
            message: code ? `${message} (${code})` : message,
            code,
            status: response.status,
            // Grants can be restored without changing the draft's identity.
            terminal:
              code !== "target_team_missing_grant" &&
              [400, 403, 404, 409].includes(response.status),
          };
          errorRef.current = creationError;
          setError(creationError);
          return null;
        }

        const parsed = createSessionResponseSchema.safeParse(
          await response.json().catch(() => null)
        );
        if (!parsed.success) return null;
        const { sessionId } = parsed.data;
        if (pending.claimed) return sessionId;
        if (!isCurrent()) {
          void discardWarmDraftSession(sessionId);
          return null;
        }

        sessionIdRef.current = sessionId;
        setSessionId(sessionId);
        return sessionId;
      } catch (error) {
        console.error("Failed to create session for warming:", error);
        return null;
      } finally {
        if (pendingRef.current === pending) {
          pendingRef.current = null;
          setIsWarming(false);
        }
      }
    })();

    pendingRef.current = pending;
    return pending.promise;
  }, []);

  /** Takes ownership of the ready or in-flight draft, starting one if needed. */
  const claim = useCallback(async (): Promise<string | null> => {
    const ready = sessionIdRef.current;
    if (ready) {
      sessionIdRef.current = null;
      setSessionId(null);
      return ready;
    }
    if (!pendingRef.current) void warm();
    const pending = pendingRef.current;
    if (!pending) return null;
    pending.claimed = true;
    pendingRef.current = null;
    setIsWarming(false);
    return pending.promise;
  }, [warm]);

  /**
   * Hands back a claimed draft whose first prompt was not sent. It becomes the
   * warm draft again while the composer still wants that launch, and is
   * discarded otherwise. The discard is a no-op for a session that did receive
   * the prompt, so an ambiguous failure cannot lose work.
   */
  const release = useCallback((releasedSessionId: string, launchIdentity: string | null) => {
    if (disposedRef.current || launchIdentity !== identityRef.current || sessionIdRef.current) {
      void discardWarmDraftSession(releasedSessionId);
      return;
    }
    sessionIdRef.current = releasedSessionId;
    setSessionId(releasedSessionId);
  }, []);

  return { identity, sessionId, isWarming, warm, claim, release, error };
}
