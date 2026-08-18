from __future__ import annotations

import ast
import json
from pathlib import Path
import unittest
from collections import OrderedDict
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
CONTRACTS = ROOT / "packages" / "schema" / "contracts"
GENERATED = ROOT / "packages" / "sdk" / "python" / "agent_feed" / "generated" / "protocol.py"
SCHEMA_ROOTS = {
    "begin-run.schema.json": "BeginRunRequest",
    "complete-run.schema.json": "CompleteRunRequest",
    "delivery-event.schema.json": "DeliveryEvent",
    "evidence.schema.json": "SubmittedEvidence",
    "finding.schema.json": "Finding",
    "run-bundle.schema.json": "RunBundle",
    "run-envelope.schema.json": "RunEnvelope",
    "stream-expectation.schema.json": "StreamExpectation",
    "submit-batch.schema.json": "SubmitBatchRequest",
}
ROOT_FILES = {root: filename for filename, root in SCHEMA_ROOTS.items()}


def _pascal(value: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in value.replace("-", "_").split("_") if part)


def _expected_declarations(schemas: dict[str, dict[str, Any]]) -> OrderedDict[str, dict[str, Any]]:
    declarations: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def register(name: str, schema: Any) -> None:
        if isinstance(schema, dict) and name not in declarations:
            declarations[name] = schema

    def local_reference(reference: str, owner: str) -> dict[str, Any] | None:
        if not reference.startswith("#/$defs/"):
            basename = reference.rsplit("/", 1)[-1]
            root_name = SCHEMA_ROOTS.get(basename)
            if root_name is not None:
                register(root_name, schemas[basename])
            return None
        root_name = max((name for name in declarations if owner == name or owner.startswith(name)), key=len, default="")
        root_schema = schemas.get(ROOT_FILES.get(root_name, ""))
        definition_name = reference.removeprefix("#/$defs/")
        definition = root_schema.get("$defs", {}).get(definition_name) if isinstance(root_schema, dict) else None
        if isinstance(definition, dict):
            register(f"{root_name}{_pascal(definition_name)}", definition)
            return definition
        return None

    def discover(schema: Any, owner: str) -> None:
        if not isinstance(schema, dict):
            return
        reference = schema.get("$ref")
        if isinstance(reference, str):
            local_reference(reference, owner)
            return
        for variant_key in ("oneOf", "anyOf", "allOf"):
            variants = schema.get(variant_key)
            if isinstance(variants, list):
                for variant in variants:
                    discover(variant, owner)
        if schema.get("type") == "object" and isinstance(schema.get("properties"), dict) and schema["properties"]:
            register(owner, schema)
            for key, child in schema["properties"].items():
                discover(child, f"{owner}{_pascal(key)}")
        definitions = schema.get("$defs")
        if isinstance(definitions, dict):
            for key, child in definitions.items():
                register(f"{owner}{_pascal(key)}", child)
        if schema.get("type") == "array":
            discover(schema.get("items"), f"{owner}Item")

    for filename, root_name in SCHEMA_ROOTS.items():
        register(root_name, schemas[filename])
    index = 0
    while index < len(declarations):
        owner, schema = list(declarations.items())[index]
        discover(schema, owner)
        index += 1
    return declarations


class SchemaDriftTests(unittest.TestCase):
    def test_generated_python_protocol_fields_match_canonical_contracts(self) -> None:
        if not CONTRACTS.is_dir() or not GENERATED.is_file():
            raise unittest.SkipTest("canonical schemas are unavailable outside the repository checkout")
        schemas = {
            filename: json.loads((CONTRACTS / filename).read_text(encoding="utf-8"))
            for filename in SCHEMA_ROOTS
        }
        self.assertEqual(set(schemas), set(SCHEMA_ROOTS))
        tree = ast.parse(GENERATED.read_text(encoding="utf-8"), filename=str(GENERATED))
        generated_fields = {
            node.name: {
                statement.target.id
                for statement in node.body
                if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name)
            }
            for node in tree.body
            if isinstance(node, ast.ClassDef)
        }
        expected = {
            name: set(schema.get("properties", {}))
            for name, schema in _expected_declarations(schemas).items()
            if schema.get("type") == "object" and schema.get("properties")
        }
        self.assertEqual(set(generated_fields), set(expected))
        for name, fields in expected.items():
            self.assertEqual(generated_fields[name], fields, name)

        protocol_assignment = next(
            node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "PROTOCOL_VERSION" for target in node.targets)
        )
        self.assertIsInstance(protocol_assignment.value, ast.Constant)
        self.assertEqual(protocol_assignment.value.value, "0.1")


if __name__ == "__main__":
    unittest.main()
