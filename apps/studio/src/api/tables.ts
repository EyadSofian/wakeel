import { useQuery } from "@tanstack/react-query";
import { ListTableSchemasResponse } from "@wakeel/contracts";
import { api } from "./client";

export const tablePath = (workspaceId: string, botId: string) => `/v1/workspaces/${workspaceId}/bots/${botId}/tables`;

export function useTableSchemas(workspaceId: string, botId: string) {
  const path = tablePath(workspaceId, botId);
  return useQuery({
    queryKey: ["tables", workspaceId, botId],
    queryFn: async () => ListTableSchemasResponse.parse(await api("GET", `${path}?limit=100`)).data,
  });
}
