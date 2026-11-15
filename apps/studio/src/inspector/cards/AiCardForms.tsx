import { newElementId } from "@wakeel/contracts";
import { Select, Switch, Textarea } from "@wakeel/ui";
import { useId } from "react";
import { ModelField } from "../autonomous/ModelSection";
import { FieldShell, type Problem, SchemaField, StringField, useDraft, useIssueAt } from "../fields";
import { ListEditor } from "../message/MessageEditor";
import { type CardFormProps, VariableSelect } from "./CardForms";

/**
 * The AI card forms (task 6.7): AI condition, Generate text and Extract data. Each runs one model
 * call; the model is the card's own or, when none is chosen, the bot's default.
 */

/** A card's optional model: picking "Bot default" removes the field. */
function CardModel<C extends { model?: string | undefined }>({ card, commit }: { card: C; commit: (card: C) => void }) {
  return (
    <ModelField
      value={card.model}
      onChange={(model) => {
        const { model: _old, ...rest } = card;
        commit((model ? { ...rest, model } : rest) as C);
      }}
    />
  );
}

/** Plain text the model reads as-is (no `{{ }}`), such as a branch description. */
function PlainText({
  label,
  help,
  value,
  max,
  path,
  onCommit,
}: {
  label: string;
  help: string;
  value: string;
  max: number;
  path: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useDraft(value);
  const stored = useIssueAt(path);
  const local: Problem | undefined =
    draft.trim() === ""
      ? { message: "This field is empty.", fix: "Describe it in a sentence." }
      : draft.length > max
        ? { message: `This is longer than ${max} characters.`, fix: "Shorten it." }
        : undefined;
  const problem = local ?? (draft === value ? stored : undefined);
  return (
    <FieldShell label={label} help={help} problem={problem} path={path}>
      {({ invalid, ...p }) => (
        <Textarea
          {...p}
          dir="auto"
          rows={2}
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !local && draft !== value && onCommit(draft)}
        />
      )}
    </FieldShell>
  );
}

export function AiConditionForm({ card, node, path, commit }: CardFormProps<"ai_branch">) {
  return (
    <>
      <p className="text-small text-secondary">
        The model reads the text and picks the option whose description fits best. If none fits, the next card runs.
      </p>
      <StringField
        label="Text to read"
        help="Usually the user's message, {{event.text}}."
        value={card.input}
        check="required"
        path={`${path}.input`}
        node={node}
        rows={1}
        onCommit={(input) => commit({ ...card, input })}
      />
      <ListEditor
        label="Options"
        addLabel="Add option"
        items={card.branches}
        min={1}
        max={20}
        make={(i) => ({
          id: newElementId("br"),
          label: `Option ${i + 1}`,
          description: "Describe when to go this way.",
        })}
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
            <PlainText
              label="When"
              help="What the text is about when this option fits. The model reads this."
              value={b.description}
              max={500}
              path={`${path}.branches.${b.id}.description`}
              onCommit={(description) =>
                commit({ ...card, branches: card.branches.map((x) => (x.id === b.id ? { ...x, description } : x)) })
              }
            />
          </>
        )}
      />
      <CardModel card={card} commit={commit} />
    </>
  );
}

/** Longest replies offered for Generate text (`maxOutputTokens` allows 16 to 8,000). */
const TOKEN_LIMITS = [200, 400, 800, 1_600, 4_000, 8_000];

export function GenerateTextForm({ card, node, path, commit }: CardFormProps<"ai_generate">) {
  const limitId = useId();
  const limits = TOKEN_LIMITS.includes(card.maxOutputTokens)
    ? TOKEN_LIMITS
    : [...TOKEN_LIMITS, card.maxOutputTokens].sort((a, b) => a - b);
  return (
    <>
      <StringField
        label="Instructions"
        help="What to write. The model follows these; the text below is only what it works on."
        value={card.instructions}
        check="required"
        path={`${path}.instructions`}
        node={node}
        onCommit={(instructions) => commit({ ...card, instructions })}
      />
      <StringField
        label="Text to work on"
        help="Optional, for example {{event.text}}."
        value={card.input ?? ""}
        check="text"
        path={`${path}.input`}
        node={node}
        rows={1}
        onCommit={(input) => {
          const { input: _old, ...rest } = card;
          commit(input ? { ...rest, input } : rest);
        }}
      />
      <VariableSelect
        label="Save the text to"
        value={card.into}
        path={`${path}.into`}
        node={node}
        createType="string"
        toCard={(into) => ({ ...card, into })}
        commit={commit}
      />
      <Switch
        label="Also send it to the user"
        hint="The text is sent as a message as well as saved."
        checked={card.send}
        onChange={(send) => commit({ ...card, send })}
      />
      <div className="flex flex-col gap-3">
        <label htmlFor={limitId} className="text-small font-medium text-primary">
          Longest reply
        </label>
        <Select
          id={limitId}
          value={String(card.maxOutputTokens)}
          onChange={(e) => commit({ ...card, maxOutputTokens: Number(e.target.value) })}
        >
          {limits.map((n) => (
            <option key={n} value={n}>
              {`${n.toLocaleString("en")} tokens`}
            </option>
          ))}
        </Select>
        <p className="text-small text-tertiary">The model stops writing at this length.</p>
      </div>
      <CardModel card={card} commit={commit} />
    </>
  );
}

export function ExtractDataForm({ card, node, path, commit }: CardFormProps<"ai_extract">) {
  return (
    <>
      <StringField
        label="Text to read"
        help="Usually the user's message, {{event.text}}."
        value={card.input}
        check="required"
        path={`${path}.input`}
        node={node}
        rows={1}
        onCommit={(input) => commit({ ...card, input })}
      />
      <SchemaField
        label="Fields"
        help="JSON Schema of what to pull out. A result that does not match is retried once, then the card fails."
        value={card.schema}
        required
        path={`${path}.schema`}
        onCommit={(schema) => schema && commit({ ...card, schema })}
      />
      <StringField
        label="Instructions"
        help="Optional hints, for example how to write dates."
        value={card.instructions ?? ""}
        check="text"
        path={`${path}.instructions`}
        node={node}
        onCommit={(instructions) => {
          const { instructions: _old, ...rest } = card;
          commit(instructions ? { ...rest, instructions } : rest);
        }}
      />
      <VariableSelect
        label="Save the fields to"
        value={card.into}
        path={`${path}.into`}
        node={node}
        createType="object"
        toCard={(into) => ({ ...card, into })}
        commit={commit}
      />
      <CardModel card={card} commit={commit} />
    </>
  );
}
