import { useMutation } from "@tanstack/react-query";
import { EvalCase, EvalCaseEntry, type Message } from "@wakeel/contracts";
import { Button, Field, Input, Select, Sheet, Skeleton } from "@wakeel/ui";
import { useState } from "react";
import { api } from "../../api/client";
import { useEvalSuites } from "../../api/evals";
import { ProblemBanner } from "../../shell/ProblemBanner";

export function AddConversationCase({
  path,
  messages,
  hasEarlier,
}: {
  path: string;
  messages: Message[];
  hasEarlier: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [suiteId, setSuiteId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const query = useEvalSuites(path, open);
  const suites = query.data?.pages.flatMap((item) => item.data) ?? [];
  const suite = suiteId || suites[0]?.id;
  const turns = messages.flatMap<{ user: string } | { postback: string }>((item) => {
    if (item.direction !== "in") return [];
    if (item.payload.type === "text" && item.payload.text.trim()) return [{ user: item.payload.text }];
    if (item.payload.type === "postback") return [{ postback: item.payload.value }];
    return [];
  });
  const create = useMutation({
    mutationFn: async () =>
      EvalCaseEntry.parse(
        await api(
          "POST",
          `${path}/suites/${suite}/cases`,
          EvalCase.parse({
            name,
            turns: turns.slice(0, 50),
          }),
        ),
      ),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setMessage("Eval case added.");
    },
  });
  return (
    <div>
      <Button
        disabled={!turns.length || hasEarlier}
        onClick={() => {
          setMessage("");
          create.reset();
          setOpen(true);
        }}
      >
        Add eval case
      </Button>
      {message && (
        <p role="status" className="text-small">
          {message}
        </p>
      )}
      <Sheet title="Add case from conversation" open={open} onOpenChange={setOpen}>
        <form
          className="flex flex-col gap-5 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          {query.isPending && <Skeleton className="h-12 w-full" />}
          {query.isError && <ProblemBanner error={query.error} />}
          {query.data && !suites.length && <p className="text-body">Create a suite in Evals first.</p>}
          {!!suites.length && (
            <Field label="Suite">
              {(props) => (
                <Select {...props} value={suite} onChange={(event) => setSuiteId(event.target.value)}>
                  {suites.map((item) => (
                    <option key={item.id} value={item.id} dir="auto">
                      {item.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>Load more suites</Button>}
          <Field label="Case name">
            {(props) => (
              <Input
                {...props}
                dir="auto"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <p className="text-small text-secondary">
            Copies up to 50 text messages and choices. Review the text and add assertions in Evals.
          </p>
          {create.isError && <ProblemBanner error={create.error} />}
          <Button type="submit" variant="primary" disabled={!suite || !name.trim() || create.isPending}>
            Add case
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
