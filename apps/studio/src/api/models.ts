import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ModelDefaultsRequest,
  ModelKeyStatus,
  ModelProvider,
  ModelSummary,
  PutModelKeyRequest,
} from "@wakeel/contracts";
import { api } from "./client";
import { keys } from "./queries";

/** Settings → Models (task 6.2). */
const modelKeys = {
  models: (ws: string) => ["workspace", ws, "models"] as const,
  keys: (ws: string) => ["workspace", ws, "model-keys"] as const,
};

export function useModels(ws: string) {
  return useQuery({
    queryKey: modelKeys.models(ws),
    queryFn: () => api<{ data: ModelSummary[] }>("GET", `/v1/workspaces/${ws}/models`).then((p) => p.data),
  });
}

export function useModelKeys(ws: string, enabled = true) {
  return useQuery({
    queryKey: modelKeys.keys(ws),
    enabled,
    queryFn: () => api<{ data: ModelKeyStatus[] }>("GET", `/v1/workspaces/${ws}/model-keys`).then((p) => p.data),
  });
}

function useRefresh(ws: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: modelKeys.keys(ws) }),
      qc.invalidateQueries({ queryKey: modelKeys.models(ws) }),
      qc.invalidateQueries({ queryKey: keys.workspace(ws) }),
    ]);
}

export function usePutModelKey(ws: string) {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: ({ provider, ...body }: PutModelKeyRequest & { provider: ModelProvider }) =>
      api<ModelKeyStatus>("PUT", `/v1/workspaces/${ws}/model-keys/${provider}`, body),
    onSuccess: refresh,
  });
}

export function useDeleteModelKey(ws: string) {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: (provider: ModelProvider) => api<void>("DELETE", `/v1/workspaces/${ws}/model-keys/${provider}`),
    onSuccess: refresh,
  });
}

export function useModelDefaults(ws: string) {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: (body: ModelDefaultsRequest) =>
      api<ModelDefaultsRequest>("PUT", `/v1/workspaces/${ws}/model-defaults`, body),
    onSuccess: refresh,
  });
}
