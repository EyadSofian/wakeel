import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BotDefinition,
  type ConfigEnv,
  type ConfigVariableResponse,
  type PublishRequest,
  type RestoreResponse,
  type VersionResponse,
  type VersionSummary,
} from "@wakeel/contracts";
import { api } from "./client";
import { botKeys } from "./queries";

/** Versions and config values (tasks 7.1, 7.3, ADR-036, ADR-037). */
interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

const base = (ws: string, bot: string) => `/v1/workspaces/${ws}/bots/${bot}`;

export const versionKeys = {
  all: (ws: string, bot: string) => ["versions", ws, bot] as const,
  one: (ws: string, bot: string, id: string) => ["versions", ws, bot, id] as const,
  config: (ws: string, bot: string) => ["config", ws, bot] as const,
};

/** Every version, newest first (a bot has tens; the page size is the api's maximum). */
export function useVersions(ws: string, bot: string) {
  return useQuery({
    queryKey: versionKeys.all(ws, bot),
    queryFn: () => api<Page<VersionSummary>>("GET", `${base(ws, bot)}/versions?limit=100`).then((p) => p.data),
  });
}

/** One version with its definition, parsed so defaults are filled in before a diff (7.4). */
export function useVersion(ws: string, bot: string, id: string | undefined) {
  return useQuery({
    queryKey: versionKeys.one(ws, bot, id ?? ""),
    enabled: id !== undefined,
    queryFn: async () => {
      const v = await api<VersionResponse>("GET", `${base(ws, bot)}/versions/${id}`);
      return { ...v, definition: BotDefinition.parse(v.definition) };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

function useRefresh(ws: string, bot: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: versionKeys.all(ws, bot) }),
      qc.invalidateQueries({ queryKey: botKeys.list(ws) }),
    ]);
}

export function usePublish(ws: string, bot: string) {
  const refresh = useRefresh(ws, bot);
  return useMutation({
    mutationFn: (body: PublishRequest) => api<VersionSummary>("POST", `${base(ws, bot)}/versions`, body),
    onSuccess: refresh,
  });
}

export function useRollback(ws: string, bot: string) {
  const refresh = useRefresh(ws, bot);
  return useMutation({
    mutationFn: (versionId: string) =>
      api<VersionSummary>("POST", `${base(ws, bot)}/versions/${versionId}/rollback`, {}),
    onSuccess: refresh,
  });
}

export function useRestore(ws: string, bot: string) {
  return useMutation({
    mutationFn: (versionId: string) =>
      api<RestoreResponse>("POST", `${base(ws, bot)}/versions/${versionId}/restore`, {}),
  });
}

export function useConfigVars(ws: string, bot: string) {
  return useQuery({
    queryKey: versionKeys.config(ws, bot),
    queryFn: () => api<Page<ConfigVariableResponse>>("GET", `${base(ws, bot)}/config`).then((p) => p.data),
  });
}

export function useSetConfigValue(ws: string, bot: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { env: ConfigEnv; key: string; value: string }) =>
      api<void>("PUT", `${base(ws, bot)}/config/${v.env}/${v.key}`, { value: v.value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: versionKeys.config(ws, bot) }),
  });
}

export function useDeleteConfigValue(ws: string, bot: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { env: ConfigEnv; key: string }) =>
      api<void>("DELETE", `${base(ws, bot)}/config/${v.env}/${v.key}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: versionKeys.config(ws, bot) }),
  });
}
