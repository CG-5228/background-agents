import { browserApiFetch } from "@/lib/browser-api-fetch";

/**
 * Discards a warm draft the composer no longer needs. The control plane only
 * removes a session that never received a prompt, so this is safe to call for
 * a draft whose send may have landed.
 */
export async function discardWarmDraftSession(sessionId: string): Promise<void> {
  try {
    const response = await browserApiFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/discard-draft`,
      { method: "POST" }
    );
    if (!response.ok) throw new Error(`Warm session discard failed: ${response.status}`);
  } catch (error) {
    console.error("Failed to discard warm draft session:", error);
  }
}
