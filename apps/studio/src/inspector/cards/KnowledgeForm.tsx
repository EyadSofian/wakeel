import { Field, Select, Switch } from "@wakeel/ui";
import { ModelField } from "../autonomous/ModelSection";
import { StringField, useVariables } from "../fields";
import { KnowledgeFields } from "../KnowledgeFields";
import type { CardFormProps } from "./CardForms";

export function KnowledgeForm({ card, node, path, commit }: CardFormProps<"kb_search">) {
  const variables = useVariables().filter(
    (v) => v.id !== "" && v.scope !== "bot" && (v.type === "object" || v.type === "any"),
  );
  const { into: _into, answer: _answer, ...base } = card;
  return (
    <>
      <KnowledgeFields kbIds={card.kbIds} topK={card.topK} onChange={(patch) => commit({ ...card, ...patch })} />
      <StringField
        label="Query"
        value={card.query}
        check="text"
        path={`${path}.query`}
        node={node}
        onCommit={(query) => commit({ ...card, query })}
      />
      <Field label="Save passages to">
        {(props) => (
          <Select
            {...props}
            value={card.into ?? ""}
            onChange={(e) => {
              const into = e.target.value;
              commit({ ...base, ...(card.answer ? { answer: card.answer } : {}), ...(into ? { into } : {}) });
            }}
          >
            <option value="">Do not save</option>
            {variables.map((v) => (
              <option key={v.id} value={v.id}>
                {v.path}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Save generated answer to">
        {(props) => (
          <Select
            {...props}
            value={card.answer?.into ?? ""}
            onChange={(e) => {
              const into = e.target.value;
              commit({
                ...base,
                ...(card.into ? { into: card.into } : {}),
                ...(into ? { answer: { ...card.answer, into, send: card.answer?.send ?? false } } : {}),
              });
            }}
          >
            <option value="">Do not generate an answer</option>
            {variables.map((v) => (
              <option key={v.id} value={v.id}>
                {v.path}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {card.answer && (
        <>
          <Switch
            label="Send the generated answer"
            checked={card.answer.send}
            onChange={(send) => {
              if (card.answer) commit({ ...card, answer: { ...card.answer, send } });
            }}
          />
          <StringField
            label="Answer instructions"
            value={card.answer.instructions ?? ""}
            check="text"
            path={`${path}.answer.instructions`}
            node={node}
            onCommit={(instructions) => {
              if (card.answer) commit({ ...card, answer: { ...card.answer, instructions } });
            }}
          />
          <ModelField
            value={card.answer.model}
            onChange={(model) => {
              if (!card.answer) return;
              const { model: _model, ...answer } = card.answer;
              commit({ ...card, answer: { ...answer, ...(model ? { model } : {}) } });
            }}
          />
        </>
      )}
    </>
  );
}
