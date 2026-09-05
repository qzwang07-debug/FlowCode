import { z } from "zod";

export const ContractIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ContractSourceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/);
export const ContractTimeSchema = z.number().int().nonnegative().finite();
export const ContractTextSchema = z.string().trim().min(1).max(2000);
export const ContractRevisionSchema = z
  .object({
    id: ContractIdSchema,
    revision: z.number().int().positive(),
    contentHash: ContentHashSchema,
  })
  .strict();

export function uniqueIds(
  items: readonly { id: string }[],
  ctx: z.RefinementCtx,
  field: string,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      ctx.addIssue({
        code: "custom",
        path: [field, index, "id"],
        message: "Duplicate ID.",
      });
    seen.add(item.id);
  });
}
