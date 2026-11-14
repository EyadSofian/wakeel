import type { IoField } from "@wakeel/contracts";
import { Select, Switch, VariablePicker } from "@wakeel/ui";
import { useMemo } from "react";
import { useCanvas } from "../../canvas/context";
import { TYPE_LABELS } from "../../routes/variables/model";
import { FieldShell, StringField, useIssueAt, useVariables } from "../fields";
import { ListEditor, MessageEditor } from "../message/MessageEditor";
import { type CardFormProps, VariableSelect } from "./CardForms";

/**
 * Forms for the cards that leave the node's flow: Hand off to a person and Run workflow (tasks 5.4,
 * 6.6). Like the other card forms, each commits a whole new card as one undo step.
 */

const GROUPS: Record<string, string> = {
  bot: "Bot",
  workflow: "Workflow",
  conversation: "Conversation",
  user: "User",
};

export function HandoffForm({ card, node, path, commit }: CardFormProps<"handoff">) {
  const variables = useVariables().filter((v) => v.id !== "");
  const options = variables.map((v) => ({ id: v.id, path: v.path, type: v.type, group: GROUPS[v.scope] ?? v.scope }));
  const unused = (taken: readonly string[]) => variables.find((v) => !taken.includes(v.id))?.id;
  return (
    <>
      <p className="text-small text-secondary">
        The conversation goes to a person through the connection. The bot stays silent until it is handed back.
      </p>
      <Switch
        label="Send a message first"
        hint="Tells the user a person is joining."
        checked={card.message !== undefined}
        onChange={(on) => {
          const { message: _old, ...rest } = card;
          commit(
            on
              ? {
                  ...rest,
                  message: { type: "text", text: "A person from our team will reply here.", format: "markdown" },
                }
              : rest,
          );
        }}
      />
      {card.message ? (
        <MessageEditor
          message={card.message}
          node={node}
          path={`${path}.message`}
          onCommit={(message) => commit({ ...card, message })}
        />
      ) : null}
      <StringField
        label="Reason"
        help="Optional. Sent with the handoff so the person knows why, for example a refund request."
        value={card.reason}
        check="text"
        path={`${path}.reason`}
        node={node}
        rows={1}
        onCommit={(reason) => commit({ ...card, reason })}
      />
      <Switch
        label="Summarise the conversation"
        hint="The utility model writes a short summary for the person taking over."
        checked={card.summary === "auto"}
        onChange={(on) => commit({ ...card, summary: on ? "auto" : "none" })}
      />
      <ListEditor
        label="Variables to include"
        addLabel="Add variable"
        items={card.include}
        min={0}
        max={Math.min(30, variables.length)}
        make={() => unused(card.include) ?? ""}
        onChange={(include) => commit({ ...card, include: include.filter((id) => id !== "") })}
        render={(id, i) => (
          <IncludedVariable
            value={id}
            path={`${path}.include[${i}]`}
            options={options.filter((o) => o.id === id || !card.include.includes(o.id))}
            onChange={(variableId) =>
              commit({ ...card, include: card.include.map((x, j) => (j === i ? variableId : x)) })
            }
          />
        )}
      />
    </>
  );
}

function IncludedVariable({
  value,
  path,
  options,
  onChange,
}: {
  value: string;
  path: string;
  options: { id: string; path: string; type: string; group: string }[];
  onChange: (variableId: string) => void;
}) {
  const issue = useIssueAt(path);
  return (
    <FieldShell label="Variable" problem={issue} path={path}>
      {({ id, invalid, ...rest }) => (
        <VariablePicker id={id} value={value} options={options} invalid={invalid} onChange={onChange} {...rest} />
      )}
    </FieldShell>
  );
}

export function RunWorkflowForm({ card, node, path, commit }: CardFormProps<"call_workflow">) {
  const workflows = useCanvas((s) => s.workflows);
  const activeId = useCanvas((s) => s.activeWorkflowId);
  const subs = useMemo(
    () =>
      Object.values(workflows)
        .map((w) => w.doc)
        .filter((w) => w.kind === "sub" && w.id !== activeId),
    [workflows, activeId],
  );
  const target = subs.find((w) => w.id === card.workflowId);
  const issue = useIssueAt(`${path}.workflowId`);

  const setInput = (field: IoField, value: string) => {
    const { [field.name]: _old, ...rest } = card.inputs;
    commit({ ...card, inputs: value.trim() ? { ...rest, [field.name]: value } : rest });
  };

  return (
    <>
      <FieldShell
        label="Workflow"
        help="The sub-workflow runs, then this node goes on with the next card."
        problem={issue ?? (target ? undefined : { message: "This workflow no longer exists.", fix: "Choose another." })}
        path={`${path}.workflowId`}
      >
        {({ invalid, ...rest }) => (
          <Select
            {...rest}
            aria-invalid={invalid || undefined}
            value={target ? card.workflowId : ""}
            // Another workflow has other inputs and outputs, so the old mappings are dropped.
            onChange={(e) => commit({ ...card, workflowId: e.target.value, inputs: {}, outputs: {} })}
          >
            {target ? null : <option value="">Choose a workflow</option>}
            {subs.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
      </FieldShell>
      {target ? (
        <>
          <fieldset className="flex flex-col gap-5">
            <legend className="pb-3 text-small font-medium text-primary">Inputs</legend>
            {target.inputs.length === 0 ? (
              <p className="text-small text-tertiary">{`${target.name} takes no inputs.`}</p>
            ) : (
              target.inputs.map((field) => (
                <StringField
                  key={field.name}
                  label={field.name}
                  help={
                    field.description ??
                    (field.required ? `Required · ${TYPE_LABELS[field.type]}` : `Optional · ${TYPE_LABELS[field.type]}`)
                  }
                  value={card.inputs[field.name] ?? ""}
                  check={field.required ? "expression" : "optional-expression"}
                  path={`${path}.inputs.${field.name}`}
                  node={node}
                  onCommit={(value) => setInput(field, value)}
                />
              ))
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-5">
            <legend className="pb-3 text-small font-medium text-primary">Outputs</legend>
            {target.outputs.length === 0 ? (
              <p className="text-small text-tertiary">{`${target.name} returns nothing.`}</p>
            ) : (
              target.outputs.map((field) => (
                <VariableSelect
                  key={field.name}
                  label={`Save ${field.name} to`}
                  value={card.outputs[field.name] ?? ""}
                  path={`${path}.outputs.${field.name}`}
                  node={node}
                  createType={field.type}
                  toCard={(variableId) => ({ ...card, outputs: { ...card.outputs, [field.name]: variableId } })}
                  commit={commit}
                />
              ))
            )}
          </fieldset>
        </>
      ) : null}
    </>
  );
}
