import type { FromSchema } from "json-schema-to-ts";
import findingSchema from "./contracts/finding.schema.json";

export type Finding = FromSchema<typeof findingSchema>;
export { findingSchema };
