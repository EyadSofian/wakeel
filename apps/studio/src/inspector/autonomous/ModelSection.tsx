import type { AutonomousNode } from "@wakeel/contracts";
import { Field } from "@wakeel/ui";
import { createContext, useContext } from "react";
import { useModels } from "../../api/models";
import { ModelPicker } from "../../routes/settings/models/ModelPicker";
import { ProblemBanner } from "../../shell/ProblemBanner";

/** The workspace the open bot belongs to; the inspector needs it for workspace-level lists. */
export const InspectorWorkspace = createContext<string | undefined>(undefined);

/**
 * The node's model (task 6.6): its own, or the bot's default when none is chosen. Models whose
 * provider has no key in this workspace are listed but cannot be chosen (task 6.2).
 */
export function ModelField({
  node,
  onChange,
}: {
  node: AutonomousNode;
  onChange: (model: AutonomousNode["model"]) => void;
}) {
  const workspaceId = useContext(InspectorWorkspace);
  if (!workspaceId) return null;
  return <Picker workspaceId={workspaceId} node={node} onChange={onChange} />;
}

function Picker({
  workspaceId,
  node,
  onChange,
}: {
  workspaceId: string;
  node: AutonomousNode;
  onChange: (model: AutonomousNode["model"]) => void;
}) {
  const models = useModels(workspaceId);
  // A node names a model as `provider:id`; the registry lists ids.
  const current = node.model ? node.model.slice(node.model.indexOf(":") + 1) : null;
  return (
    <div className="flex flex-col gap-3">
      {models.isError ? <ProblemBanner error={models.error} /> : null}
      <Field label="Model" help="Bot default uses the model in the bot's settings.">
        {(p) => (
          <ModelPicker
            {...p}
            models={models.data ?? []}
            value={current}
            disabled={!models.data}
            allowNone="Bot default"
            onValueChange={(id) => {
              const model = id ? models.data?.find((m) => m.id === id) : undefined;
              onChange(model ? `${model.provider}:${model.id}` : undefined);
            }}
          />
        )}
      </Field>
    </div>
  );
}
