import { Card, type Node, newElementId, type Variable, type VariableType } from "@wakeel/contracts";
import { SegmentedControl, Select, Switch, VariablePicker } from "@wakeel/ui";
import { useId } from "react";
import { useCanvasStore } from "../../canvas/context";
import { commands } from "../../canvas/store/commands";
import { FieldShell, StringField, useIssueAt, useVariables } from "../fields";
import { ListEditor, MessageEditor } from "../message/MessageEditor";

/**
 * Card forms (task 2.6): Send message, Ask, Condition, Set variable, Log, End conversation. Each
 * gets the card, its node, the issue path prefix of the card, and `commit`, which writes a whole
 * new card as one undo step (and refuses a schema-invalid one).
 */
export interface CardFormProps<T extends Card["type"]> {
  card: Extract<Card, { type: T }>;
  node: Node;
  path: string;
  commit: (card: Card) => void;
}

export function SayForm({ card, node, path, commit }: CardFormProps<"say">) {
  return (
    <MessageEditor
      message={card.message}
      node={node}
      path={`${path}.message`}
      onCommit={(message) => commit({ ...card, message })}
    />
  );
}

const KINDS = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes or no" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone number" },
  { value: "date", label: "Date" },
  { value: "choice", label: "One of the options" },
] as const;

/** Variables a card may write to: not bot variables (read-only at run time) and not inputs. */
function useWritable() {
  return useVariables().filter((v) => v.id !== "" && v.scope !== "bot");
}

const GROUPS: Record<string, string> = { workflow: "Workflow", conversation: "Conversation", user: "User" };

/** What each answer type stores, for a variable created from the Ask form. */
const CAPTURE_TYPES: Record<string, VariableType> = {
  text: "string",
  number: "number",
  boolean: "boolean",
  email: "string",
  phone: "string",
  date: "date",
  choice: "string",
  extract: "object",
};

/**
 * VariablePicker for a card field (task 2.7). Picking commits the card; creating adds a workflow
 * variable of `createType` and stores into it in the same undo step.
 */
function VariableSelect({
  label,
  help,
  value,
  path,
  node,
  createType,
  toCard,
  commit,
}: {
  label: string;
  help?: string;
  value: string;
  path: string;
  node: Node;
  createType: VariableType;
  toCard: (variableId: string) => Card;
  commit: (card: Card) => void;
}) {
  const store = useCanvasStore();
  const writable = useWritable();
  const issue = useIssueAt(path);
  const options = writable.map((v) => ({ id: v.id, path: v.path, type: v.type, group: GROUPS[v.scope] ?? v.scope }));
  const create = (name: string) => {
    const variable: Variable = { id: newElementId("var"), name, scope: "workflow", type: createType, sensitive: false };
    const card = Card.safeParse(toCard(variable.id));
    if (!card.success) return;
    const add = commands.addVariable(variable);
    const update = commands.updateCard(node.id, card.data);
    store.getState().execute({ label: "Add variable", apply: (wf) => update.apply(add.apply(wf)) });
  };
  return (
    <FieldShell label={label} {...(help ? { help } : {})} problem={issue}>
      {({ id, invalid, ...rest }) => (
        <VariablePicker
          id={id}
          value={value}
          options={options}
          invalid={invalid}
          onChange={(variableId) => commit(toCard(variableId))}
          onCreate={create}
          createNoun="workflow variable"
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export function AskForm({ card, node, path, commit }: CardFormProps<"capture">) {
  const kindId = useId();
  const retriesId = useId();
  return (
    <>
      <MessageEditor
        message={card.prompt}
        node={node}
        path={`${path}.prompt`}
        types={["text", "choice", "dropdown"]}
        textLabel="Question"
        onCommit={(prompt) => commit({ ...card, prompt })}
      />
      <div className="flex flex-col gap-3">
        <label htmlFor={kindId} className="text-small font-medium text-primary">
          Answer type
        </label>
        <Select
          id={kindId}
          value={card.kind}
          onChange={(e) => commit({ ...card, kind: e.target.value as typeof card.kind })}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
          {card.kind === "extract" ? <option value="extract">Extract with AI</option> : null}
        </Select>
      </div>
      <VariableSelect
        label="Save the answer to"
        value={card.into}
        path={`${path}.into`}
        node={node}
        createType={CAPTURE_TYPES[card.kind] ?? "any"}
        toCard={(into) => ({ ...card, into })}
        commit={commit}
      />
      <Switch
        label="Check the answer"
        hint="An expression where value is the answer; when it is false, the question is asked again."
        checked={card.validate !== undefined}
        onChange={(on) => {
          const { validate: _old, ...rest } = card;
          commit(
            on
              ? {
                  ...rest,
                  validate: { expression: "String(value).length > 0", message: "Please answer the question." },
                }
              : rest,
          );
        }}
      />
      {card.validate ? (
        <>
          <StringField
            label="Check"
            value={card.validate.expression}
            check="expression"
            path={`${path}.validate.expression`}
            node={node}
            onCommit={(expression) => card.validate && commit({ ...card, validate: { ...card.validate, expression } })}
          />
          <StringField
            label="Message when the check fails"
            value={card.validate.message}
            check="required"
            path={`${path}.validate.message`}
            node={node}
            rows={1}
            onCommit={(message) => card.validate && commit({ ...card, validate: { ...card.validate, message } })}
          />
        </>
      ) : null}
      <div className="flex flex-col gap-3">
        <label htmlFor={retriesId} className="text-small font-medium text-primary">
          Attempts after a wrong answer
        </label>
        <Select
          id={retriesId}
          value={String(card.maxRetries)}
          onChange={(e) => commit({ ...card, maxRetries: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <p className="text-small text-tertiary">After the last one, the card leaves through "failed".</p>
      </div>
      <StringField
        label="Retry message"
        help="Sent before asking again. Empty uses the check message."
        value={card.retryMessage ?? ""}
        check="text"
        path={`${path}.retryMessage`}
        node={node}
        rows={1}
        onCommit={(retryMessage) => {
          const { retryMessage: _old, ...rest } = card;
          commit(retryMessage ? { ...rest, retryMessage } : rest);
        }}
      />
      <Switch
        label="Skip if already answered"
        hint="When the variable already holds a valid value, the question is not asked."
        checked={card.skipIfFilled}
        onChange={(skipIfFilled) => commit({ ...card, skipIfFilled })}
      />
      {card.kind === "choice" && card.prompt.type === "choice" ? (
        <Switch
          label="An output per option"
          hint="Each option gets its own output on the canvas."
          checked={card.routeByOption}
          onChange={(routeByOption) => commit({ ...card, routeByOption })}
        />
      ) : null}
    </>
  );
}

export function ConditionForm({ card, node, path, commit }: CardFormProps<"branch">) {
  return (
    <>
      <p className="text-small text-secondary">
        Conditions are tested top to bottom and the first true one is followed. If none is true, the next card runs.
      </p>
      <ListEditor
        label="Conditions"
        addLabel="Add condition"
        items={card.branches}
        min={1}
        max={20}
        make={(i) => ({ id: newElementId("br"), label: `Condition ${i + 1}`, when: "true" })}
        onChange={(branches) => commit({ ...card, branches })}
        render={(b) => (
          <>
            <StringField
              label="Name"
              help="Shown on the output."
              value={b.label}
              check="required"
              path={`${path}.branches.${b.id}.label`}
              node={node}
              rows={1}
              onCommit={(label) =>
                commit({ ...card, branches: card.branches.map((x) => (x.id === b.id ? { ...x, label } : x)) })
              }
            />
            <StringField
              label="When"
              value={b.when}
              check="expression"
              placeholder='conversation.topic == "order"'
              path={`${path}.branches.${b.id}.when`}
              node={node}
              onCommit={(when) =>
                commit({ ...card, branches: card.branches.map((x) => (x.id === b.id ? { ...x, when } : x)) })
              }
            />
          </>
        )}
      />
    </>
  );
}

export function SetVariableForm({ card, node, path, commit }: CardFormProps<"set_variable">) {
  const writable = useWritable();
  return (
    <ListEditor
      label="Assignments"
      addLabel="Add assignment"
      items={card.assignments}
      min={1}
      max={writable.length === 0 ? card.assignments.length : 20}
      make={() => ({ variableId: writable[0]?.id ?? "", value: '""' })}
      onChange={(assignments) => commit({ ...card, assignments })}
      render={(a, i) => (
        <>
          <VariableSelect
            label="Variable"
            value={a.variableId}
            path={`${path}.assignments[${i}].variableId`}
            node={node}
            createType="any"
            toCard={(variableId) => ({
              ...card,
              assignments: card.assignments.map((x, j) => (j === i ? { ...x, variableId } : x)),
            })}
            commit={commit}
          />
          <StringField
            label="Value"
            help="An expression: a number, text in quotes, or a calculation."
            value={a.value}
            check="expression"
            path={`${path}.assignments[${i}].value`}
            node={node}
            onCommit={(value) =>
              commit({ ...card, assignments: card.assignments.map((x, j) => (j === i ? { ...x, value } : x)) })
            }
          />
        </>
      )}
    />
  );
}

export function LogForm({ card, node, path, commit }: CardFormProps<"log">) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <span className="text-small font-medium text-primary">Level</span>
        <SegmentedControl
          label="Level"
          value={card.level}
          options={[
            { value: "info", label: "Info" },
            { value: "warn", label: "Warning" },
            { value: "error", label: "Error" },
          ]}
          onChange={(level) => commit({ ...card, level })}
        />
      </div>
      <StringField
        label="Message"
        help="Written to the trace, never sent to the user."
        value={card.message}
        check="required"
        path={`${path}.message`}
        node={node}
        onCommit={(message) => commit({ ...card, message })}
      />
      <StringField
        label="Data"
        help="Optional. An expression whose value is logged with the message."
        value={card.data ?? ""}
        check="optional-expression"
        path={`${path}.data`}
        node={node}
        onCommit={(data) => {
          const { data: _old, ...rest } = card;
          commit(data.trim() ? { ...rest, data } : rest);
        }}
      />
    </>
  );
}

export function EndForm({ card, node, path, commit }: CardFormProps<"end">) {
  return (
    <StringField
      label="Reason"
      help='Recorded on the conversation, for example "completed" or "order_cancelled".'
      value={card.reason}
      check="text"
      path={`${path}.reason`}
      node={node}
      rows={1}
      onCommit={(reason) => commit({ ...card, reason: reason || "completed" })}
    />
  );
}
