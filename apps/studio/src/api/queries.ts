import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiKeyResponse,
  InvitationResponse,
  MemberResponse,
  SessionResponse,
  WorkspaceResponse,
  WorkspaceRole,
  WorkspaceSummary,
} from "@wakeel/contracts";
import { ApiError, api, setCsrfToken } from "./client";

/** Query keys and hooks for the Phase 1 Studio API (tasks 1.2–1.6). */
interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const keys = {
  session: ["session"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspace", id] as const,
  members: (id: string) => ["workspace", id, "members"] as const,
  invitations: (id: string) => ["workspace", id, "invitations"] as const,
  apiKeys: (id: string) => ["workspace", id, "api-keys"] as const,
};

/** The signed-in session, or `null` when signed out. */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => {
      try {
        const s = await api<SessionResponse>("GET", "/v1/auth/session");
        setCsrfToken(s.csrfToken);
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.code === "unauthenticated") {
          setCsrfToken(undefined);
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

const acceptSession = (qc: QueryClient, s: SessionResponse) => {
  setCsrfToken(s.csrfToken);
  qc.setQueryData(keys.session, s);
  void qc.invalidateQueries({ queryKey: keys.workspaces });
};

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api<SessionResponse>("POST", "/v1/auth/sign-in", body),
    onSuccess: (s) => acceptSession(qc, s),
  });
}

export function useSignUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; email: string; password: string }) =>
      api<SessionResponse>("POST", "/v1/auth/sign-up", body),
    onSuccess: (s) => acceptSession(qc, s),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("POST", "/v1/auth/sign-out"),
    onSuccess: () => {
      setCsrfToken(undefined);
      qc.clear();
      qc.setQueryData(keys.session, null);
    },
  });
}

export function useWorkspaces(enabled = true) {
  return useQuery({
    queryKey: keys.workspaces,
    queryFn: () => api<Page<WorkspaceSummary>>("GET", "/v1/workspaces").then((p) => p.data),
    enabled,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string }) => api<WorkspaceResponse>("POST", "/v1/workspaces", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: keys.workspace(id),
    queryFn: () => api<WorkspaceResponse>("GET", `/v1/workspaces/${id}`),
  });
}

export function useUpdateWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; slug?: string }) =>
      api<WorkspaceResponse>("PATCH", `/v1/workspaces/${id}`, body),
    onSuccess: (w) => {
      qc.setQueryData(keys.workspace(id), w);
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

export function useMembers(id: string) {
  return useQuery({
    queryKey: keys.members(id),
    queryFn: () => api<Page<MemberResponse>>("GET", `/v1/workspaces/${id}/members`).then((p) => p.data),
  });
}

export function useChangeRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { memberId: string; role: WorkspaceRole }) =>
      api<MemberResponse>("PATCH", `/v1/workspaces/${id}/members/${v.memberId}`, { role: v.role }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.members(id) }),
  });
}

export function useRemoveMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => api<void>("DELETE", `/v1/workspaces/${id}/members/${memberId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(id) }),
  });
}

export function useInvitations(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.invitations(id),
    queryFn: () => api<Page<InvitationResponse>>("GET", `/v1/workspaces/${id}/invitations`).then((p) => p.data),
    enabled,
  });
}

export function useInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: WorkspaceRole }) =>
      api<InvitationResponse & { acceptUrl: string }>("POST", `/v1/workspaces/${id}/invitations`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(id) }),
  });
}

export function useRevokeInvitation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => api<void>("DELETE", `/v1/workspaces/${id}/invitations/${invitationId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(id) }),
  });
}

export function useAcceptInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api<WorkspaceSummary>("POST", "/v1/invitations/accept", { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

export function useApiKeys(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.apiKeys(id),
    queryFn: () => api<Page<ApiKeyResponse>>("GET", `/v1/workspaces/${id}/api-keys`).then((p) => p.data),
    enabled,
  });
}

export function useCreateApiKey(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[] }) =>
      api<ApiKeyResponse & { key: string }>("POST", `/v1/workspaces/${id}/api-keys`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys(id) }),
  });
}

export function useRevokeApiKey(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => api<void>("DELETE", `/v1/workspaces/${id}/api-keys/${keyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys(id) }),
  });
}
