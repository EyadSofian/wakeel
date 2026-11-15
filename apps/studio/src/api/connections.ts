import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BridgeDelivery,
  CreateConnectionRequest,
  StudioConnection,
  TurnResult,
  UpdateConnectionRequest,
  WebhookTestResult,
} from "@wakeel/contracts";
import { api } from "./client";

/** The Connections screens' calls (task 5.5, ADR-030). */
interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ConnectionKey {
  id: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const base = (ws: string, bot: string) => `/v1/workspaces/${ws}/bots/${bot}/connections`;

export const connectionKeys = {
  all: (ws: string, bot: string) => ["connections", ws, bot] as const,
  one: (ws: string, bot: string, id: string) => ["connections", ws, bot, id] as const,
  keys: (ws: string, bot: string, id: string) => ["connections", ws, bot, id, "keys"] as const,
  deliveries: (ws: string, bot: string, id: string, status: string) =>
    ["connections", ws, bot, id, "deliveries", status] as const,
};

export function useConnections(ws: string, bot: string) {
  return useQuery({
    queryKey: connectionKeys.all(ws, bot),
    queryFn: () => api<Page<StudioConnection>>("GET", base(ws, bot)).then((p) => p.data),
  });
}

export function useConnection(ws: string, bot: string, id: string) {
  return useQuery({
    queryKey: connectionKeys.one(ws, bot, id),
    queryFn: () => api<StudioConnection>("GET", `${base(ws, bot)}/${id}`),
  });
}

/** Writes refresh the list and the open connection. */
function useInvalidate(ws: string, bot: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: connectionKeys.all(ws, bot) });
}

export function useCreateConnection(ws: string, bot: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: (body: CreateConnectionRequest) =>
      api<StudioConnection & { signingSecret: string }>("POST", base(ws, bot), body),
    onSuccess: invalidate,
  });
}

export function useUpdateConnection(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: (body: UpdateConnectionRequest) => api<StudioConnection>("PATCH", `${base(ws, bot)}/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useConnectionKeys(ws: string, bot: string, id: string) {
  return useQuery({
    queryKey: connectionKeys.keys(ws, bot, id),
    queryFn: () => api<Page<ConnectionKey>>("GET", `${base(ws, bot)}/${id}/keys`).then((p) => p.data),
  });
}

export function useCreateConnectionKey(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: (body: { name: string }) =>
      api<ConnectionKey & { key: string }>("POST", `${base(ws, bot)}/${id}/keys`, body),
    onSuccess: invalidate,
  });
}

export function useRevokeConnectionKey(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: (keyId: string) => api<void>("DELETE", `${base(ws, bot)}/${id}/keys/${keyId}`),
    onSuccess: invalidate,
  });
}

export function useRotateSecret(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: () =>
      api<StudioConnection & { signingSecret: string }>("POST", `${base(ws, bot)}/${id}/signing-secrets/rotate`),
    onSuccess: invalidate,
  });
}

export function useFinishRotation(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: () => api<StudioConnection>("POST", `${base(ws, bot)}/${id}/signing-secrets/finish-rotation`),
    onSuccess: invalidate,
  });
}

export function useDeliveries(ws: string, bot: string, id: string, status: "all" | "dead") {
  return useQuery({
    queryKey: connectionKeys.deliveries(ws, bot, id, status),
    queryFn: () =>
      api<Page<BridgeDelivery>>(
        "GET",
        `${base(ws, bot)}/${id}/deliveries?limit=50${status === "dead" ? "&status=dead" : ""}`,
      ).then((p) => p.data),
  });
}

export function useReplay(ws: string, bot: string, id: string) {
  const invalidate = useInvalidate(ws, bot);
  return useMutation({
    mutationFn: (eventId: string) => api<void>("POST", `${base(ws, bot)}/${id}/deliveries/${eventId}/replay`),
    onSuccess: invalidate,
  });
}

export function useTestWebhook(ws: string, bot: string, id: string) {
  return useMutation({
    mutationFn: () => api<WebhookTestResult>("POST", `${base(ws, bot)}/${id}/test`),
  });
}

export function useTestMessage(ws: string, bot: string, id: string) {
  return useMutation({
    mutationFn: (text: string) => api<TurnResult>("POST", `${base(ws, bot)}/${id}/test/messages?wait=30`, { text }),
  });
}
