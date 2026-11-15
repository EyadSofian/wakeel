import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type KnowledgeSummary, KnowledgeSummary as Summary } from "@wakeel/contracts";
import { api } from "./client";

export const knowledgePath = (ws: string, bot: string) => `/v1/workspaces/${ws}/bots/${bot}/knowledge-bases`;

export function useKnowledgePage<T>(path: string, parse: (raw: unknown) => T, enabled = true, poll = false) {
  return useInfiniteQuery({
    queryKey: ["knowledge", path],
    queryFn: async ({ pageParam }) => {
      const page = await api<{ data: unknown[]; nextCursor: string | null }>(
        "GET",
        `${path}?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      );
      return { ...page, data: page.data.map(parse) };
    },
    enabled,
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...(poll ? { refetchInterval: 3000 } : {}),
  });
}

export function useKnowledgeBase(ws: string, bot: string, id: string | undefined) {
  const path = `${knowledgePath(ws, bot)}/${id ?? ""}`;
  return useQuery({
    queryKey: ["knowledge", path, "item"],
    enabled: Boolean(id),
    queryFn: async () => Summary.parse(await api("GET", path)),
  });
}

export function useKnowledgeBases(ws: string, bot: string) {
  return useKnowledgePage<KnowledgeSummary>(knowledgePath(ws, bot), (raw) => Summary.parse(raw), Boolean(ws && bot));
}
