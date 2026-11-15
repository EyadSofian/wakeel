import { useInfiniteQuery } from "@tanstack/react-query";
import { EvalSuite } from "@wakeel/contracts";
import { z } from "zod";
import { api } from "./client";

export const evalsPath = (workspaceId: string, botId: string) => `/v1/workspaces/${workspaceId}/bots/${botId}/evals`;
const page = z.object({ data: z.array(EvalSuite), nextCursor: z.string().nullable() });

export function useEvalSuites(path: string, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: ["eval-suites", path],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      page.parse(await api("GET", `${path}/suites?cursor=${pageParam || ""}`.replace(/\?cursor=$/, ""))),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
