import { type AutomationBlueprintV2 } from "../../common/blueprint-v2";
import {
  ConfirmationBindingSchema,
  RunParametersSchema,
  type ConfirmationBinding,
} from "../../common/project-execution";
import { contractHash, readBlueprintDocument } from "./blueprint-contract";

interface ConfirmationInput {
  blueprint: AutomationBlueprintV2;
  projectId: string;
  targetId: string;
  environmentProfileId: string;
  environmentHash: string;
  codeHash: string;
  planHash: string;
  parameters: unknown;
}
export function createConfirmationBinding(
  input: ConfirmationInput,
): ConfirmationBinding {
  const bp = readBlueprintDocument(input.blueprint);
  if (bp.schemaVersion !== 2)
    throw new Error("Confirmation requires a versioned execution contract.");
  return ConfirmationBindingSchema.parse({
    schemaVersion: 1,
    blueprint: {
      id: bp.id,
      revision: bp.revision,
      contentHash: bp.contentHash,
    },
    projectId: input.projectId,
    targetId: input.targetId,
    environmentProfileId: input.environmentProfileId,
    environmentHash: input.environmentHash,
    codeHash: input.codeHash,
    planHash: input.planHash,
    parametersHash: contractHash(RunParametersSchema.parse(input.parameters)),
  });
}
export function confirmationMatches(
  binding: ConfirmationBinding,
  current: ConfirmationInput,
): boolean {
  return (
    contractHash(ConfirmationBindingSchema.parse(binding)) ===
    contractHash(createConfirmationBinding(current))
  );
}
