import { Field, Input, Select } from "@wakeel/ui";
import { useKnowledgeBases } from "../api/knowledge";
import { ProblemBanner } from "../shell/ProblemBanner";
import { useShell } from "../shell/shell-store";

export function useBotKnowledge() {
  const { workspaceId, botId } = useShell();
  return useKnowledgeBases(workspaceId, botId);
}

export function KnowledgeFields({
  kbIds,
  topK,
  onChange,
}: {
  kbIds: string[];
  topK: number;
  onChange: (patch: { kbIds: string[]; topK: number }) => void;
}) {
  const bases = useBotKnowledge();
  const items = bases.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      {bases.isError && <ProblemBanner error={bases.error} />}
      <Field label="Knowledge bases" help="Select one or more bases that use the same embedding model.">
        {(props) => (
          <Select
            {...props}
            multiple
            value={kbIds}
            disabled={bases.isPending || bases.isError}
            onChange={(e) => {
              const next = Array.from(e.target.selectedOptions, (o) => o.value);
              if (next.length > 0 && next.length <= 20) onChange({ kbIds: next, topK });
            }}
          >
            {items.map((b) => (
              <option key={b.id} value={b.id} dir="auto">
                {b.name}
              </option>
            ))}
            {kbIds
              .filter((id) => !items.some((b) => b.id === id))
              .map((id) => (
                <option key={id} value={id}>
                  Unavailable knowledge base
                </option>
              ))}
          </Select>
        )}
      </Field>
      {bases.hasNextPage && (
        <button type="button" className="self-start text-accent" onClick={() => void bases.fetchNextPage()}>
          Load more knowledge bases
        </button>
      )}
      <Field label="Maximum passages">
        {(props) => (
          <Input
            {...props}
            type="number"
            min={1}
            max={20}
            key={topK}
            defaultValue={topK}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isInteger(next) && next >= 1 && next <= 20) onChange({ kbIds, topK: next });
              else e.target.value = String(topK);
            }}
          />
        )}
      </Field>
    </>
  );
}
