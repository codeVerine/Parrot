import { z } from "zod";

export const SchemaDescriptorSchema = z.object({
  fields: z.record(z.object({ type: z.string(), optional: z.boolean() })),
  unionMembers: z.array(z.string()),
});

export type SchemaDescriptor = z.infer<typeof SchemaDescriptorSchema>;

export function isAdditiveSchemaChange(oldSchema: SchemaDescriptor, newSchema: SchemaDescriptor): boolean {
  for (const [name, oldField] of Object.entries(oldSchema.fields)) {
    const next = newSchema.fields[name];
    if (!next || next.type !== oldField.type || (oldField.optional && !next.optional)) {
      return false;
    }
  }

  for (const member of oldSchema.unionMembers) {
    if (!newSchema.unionMembers.includes(member)) {
      return false;
    }
  }

  return true;
}
