import type { FromSchema } from "json-schema-to-ts";
import evidenceSchema from "./contracts/evidence.schema.json";

export type SubmittedEvidence = FromSchema<typeof evidenceSchema>;
export { evidenceSchema };
