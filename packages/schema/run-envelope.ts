import type { FromSchema } from "json-schema-to-ts";
import runEnvelopeSchema from "./contracts/run-envelope.schema.json";

export type RunEnvelope = FromSchema<typeof runEnvelopeSchema>;
export { runEnvelopeSchema };
