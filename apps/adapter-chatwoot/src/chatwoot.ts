import type { Pair } from "./config";
import { type HttpCall, UpstreamError } from "./http";

/**
 * The Chatwoot REST calls the adapter makes (application API, `api_access_token` header). Paths
 * checked against https://developers.chatwoot.com/api-reference on 2026-11-16 and against the
 * Engosoft instance (chat.engosoft.com).
 */
export interface ChatwootClient {
  sendMessage(conversationId: number, body: Record<string, unknown>): Promise<void>;
  privateNote(conversationId: number, content: string): Promise<void>;
  setStatus(conversationId: number, status: "open" | "resolved" | "pending"): Promise<void>;
  assign(conversationId: number, to: { teamId?: number; assigneeId?: number }): Promise<void>;
  addLabels(conversationId: number, labels: string[]): Promise<void>;
  typing(conversationId: number, state: "on" | "off"): Promise<void>;
}

export function chatwootClient(pair: Pair, http: HttpCall): ChatwootClient {
  const base = `${pair.chatwootBaseUrl}/api/v1/accounts/${pair.chatwootAccountId}/conversations`;
  const headers = { api_access_token: pair.chatwootToken };
  const post = async (path: string, body: unknown) => {
    let status = 0;
    try {
      status = (await http({ method: "POST", url: `${base}${path}`, headers, body })).status;
    } catch {
      status = 0;
    }
    if (status < 200 || status >= 300) throw new UpstreamError("chatwoot", status, path.replace(/\d+/g, ":id"));
  };
  return {
    sendMessage: (id, body) => post(`/${id}/messages`, { message_type: "outgoing", ...body }),
    privateNote: (id, content) => post(`/${id}/messages`, { content, message_type: "outgoing", private: true }),
    setStatus: (id, status) => post(`/${id}/toggle_status`, { status }),
    assign: (id, to) =>
      post(`/${id}/assignments`, to.assigneeId ? { assignee_id: to.assigneeId } : { team_id: to.teamId }),
    addLabels: (id, labels) => post(`/${id}/labels`, { labels }),
    async typing(id, state) {
      // Best effort (spec §4): a typing indicator is never worth a retry or an error.
      await post(`/${id}/toggle_typing_status`, { typing_status: state }).catch(() => undefined);
    },
  };
}
