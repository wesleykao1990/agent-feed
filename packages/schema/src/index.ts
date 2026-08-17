import beginRunSchema from "./contracts/begin-run.schema.json" with { type: "json" };
import completeRunSchema from "./contracts/complete-run.schema.json" with { type: "json" };
import deliveryEventSchema from "./contracts/delivery-event.schema.json" with { type: "json" };
import evidenceSchema from "./contracts/evidence.schema.json" with { type: "json" };
import findingSchema from "./contracts/finding.schema.json" with { type: "json" };
import runBundleSchema from "./contracts/run-bundle.schema.json" with { type: "json" };
import runEnvelopeSchema from "./contracts/run-envelope.schema.json" with { type: "json" };
import streamExpectationSchema from "./contracts/stream-expectation.schema.json" with { type: "json" };
import submitBatchSchema from "./contracts/submit-batch.schema.json" with { type: "json" };

export type * from "./generated/protocol.js";

/** The npm artifact version. This is independent from the wire protocol version. */
export const PACKAGE_NAME = "@agent-feed/schema" as const;
export const PACKAGE_VERSION = "0.1.1" as const;

/** The protocol version encoded in every contract's protocol_version field. */
export const PROTOCOL_VERSION = "0.1" as const;

export {
  beginRunSchema,
  completeRunSchema,
  deliveryEventSchema,
  evidenceSchema,
  findingSchema,
  runBundleSchema,
  runEnvelopeSchema,
  streamExpectationSchema,
  submitBatchSchema,
};

/**
 * Runtime JSON Schemas keyed by their stable protocol contract name.
 * The JSON files under `contracts/` remain the source of truth; this object is
 * only a convenient typed export for consumers that use a JSON Schema validator.
 */
export const schemas = Object.freeze({
  beginRun: beginRunSchema,
  completeRun: completeRunSchema,
  deliveryEvent: deliveryEventSchema,
  evidence: evidenceSchema,
  finding: findingSchema,
  runBundle: runBundleSchema,
  runEnvelope: runEnvelopeSchema,
  streamExpectation: streamExpectationSchema,
  submitBatch: submitBatchSchema,
});

export const schemaManifest = schemas;

export type SchemaName = keyof typeof schemas;
export type SchemaDocument = (typeof schemas)[SchemaName];
