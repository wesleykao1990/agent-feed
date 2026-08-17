#!/usr/bin/env python3
"""Generate protocol types from the Agent Feed JSON Schemas.

The JSON Schemas under ``packages/schema/contracts`` are the protocol source of
truth.  This generator intentionally has no third-party dependencies so that a
fresh checkout can regenerate the checked-in TypeScript and Python artifacts
before installing either SDK.  ``--check`` is used by CI to detect drift.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


BASE = Path(__file__).resolve().parents[1]
SCHEMAS = BASE / "packages/schema/contracts"
TYPESCRIPT_OUTPUT = BASE / "packages/sdk/typescript/generated/protocol.ts"
PYTHON_OUTPUT = BASE / "packages/sdk/python/agent_feed/generated/protocol.py"
MANIFEST_OUTPUT = BASE / "packages/sdk/generated/protocol-types.manifest.json"

EXPECTED_SCHEMAS = (
    "begin-run.schema.json",
    "complete-run.schema.json",
    "delivery-event.schema.json",
    "evidence.schema.json",
    "finding.schema.json",
    "run-bundle.schema.json",
    "run-envelope.schema.json",
    "stream-expectation.schema.json",
    "submit-batch.schema.json",
)

WIRE_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


def load_schemas() -> dict[str, dict[str, Any]]:
    actual = tuple(sorted(path.name for path in SCHEMAS.glob("*.json")))
    expected = tuple(sorted(EXPECTED_SCHEMAS))
    if actual != expected:
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise ValueError(f"schema set mismatch missing={missing} extra={extra}")
    result: dict[str, dict[str, Any]] = {}
    for name in EXPECTED_SCHEMAS:
        value = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"{name} must contain a JSON object")
        result[name] = value
    return result


def pascal(value: str) -> str:
    words = [word for word in re.split(r"[^A-Za-z0-9]+", value) if word]
    return "".join(word[:1].upper() + word[1:] for word in words) or "Anonymous"


def schema_root_name(filename: str) -> str:
    slug = filename.removesuffix(".schema.json")
    names = {
        "begin-run": "BeginRunRequest",
        "complete-run": "CompleteRunRequest",
        "delivery-event": "DeliveryEvent",
        "evidence": "SubmittedEvidence",
        "finding": "Finding",
        "run-bundle": "RunBundle",
        "run-envelope": "RunEnvelope",
        "stream-expectation": "StreamExpectation",
        "submit-batch": "SubmitBatchRequest",
    }
    return names.get(slug, pascal(slug))


def schema_aliases(filename: str, root_name: str) -> tuple[str, ...]:
    slug = filename.removesuffix(".schema.json")
    aliases = {
        "begin-run": ("BeginRun",),
        "complete-run": ("CompleteRun",),
        "delivery-event": ("AgentFeedDeliveryEvent",),
        "evidence": ("Evidence",),
        "submit-batch": ("SubmitBatch",),
    }
    return tuple(alias for alias in aliases.get(slug, ()) if alias != root_name)


def json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


@dataclass
class TypeModel:
    schemas: dict[str, dict[str, Any]]
    language: str
    declarations: dict[str, Any] = field(default_factory=dict)
    declaration_order: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.root_names = {
            filename: schema_root_name(filename) for filename in EXPECTED_SCHEMAS
        }
        self.ref_names: dict[str, str] = {}
        for filename, schema in self.schemas.items():
            self.ref_names[filename] = self.root_names[filename]
            schema_id = schema.get("$id")
            if isinstance(schema_id, str):
                self.ref_names[schema_id] = self.root_names[filename]

    def register(self, name: str, schema: dict[str, Any]) -> None:
        if name not in self.declarations:
            self.declarations[name] = schema
            self.declaration_order.append(name)

    def declaration_for(self, name: str, schema: dict[str, Any]) -> str:
        self.register(name, schema)
        return name

    def ref_type(self, reference: str, owner: str) -> str:
        if reference.startswith("#/$defs/"):
            definition = reference.removeprefix("#/$defs/")
            roots = [root for root in self.root_names.values() if owner == root or owner.startswith(root)]
            root = max(roots, key=len) if roots else owner.split(".", 1)[0]
            root_schema = next(
                (schema for filename, schema in self.schemas.items() if self.root_names[filename] == root),
                None,
            )
            if root_schema is None or not isinstance(root_schema.get("$defs"), dict):
                raise ValueError(f"unresolvable local reference {reference} from {owner}")
            definition_schema = root_schema["$defs"].get(definition)
            if not isinstance(definition_schema, dict):
                raise ValueError(f"unresolvable local reference {reference} from {owner}")
            return self.declaration_for(f"{root}{pascal(definition)}", definition_schema)

        basename = reference.rsplit("/", 1)[-1]
        if basename in self.ref_names:
            return self.ref_names[basename]
        if reference in self.ref_names:
            return self.ref_names[reference]
        raise ValueError(f"unresolvable schema reference {reference} from {owner}")

    def child_name(self, owner: str, key: str, suffix: str = "") -> str:
        return f"{owner}{pascal(key)}{suffix}"

    def type_for(self, schema: Any, owner: str, path: str = "") -> str:
        if not isinstance(schema, dict):
            return "unknown"
        if "$ref" in schema:
            reference = schema["$ref"]
            if not isinstance(reference, str):
                raise ValueError(f"invalid $ref at {owner}{path}")
            return self.ref_type(reference, owner)
        if "const" in schema:
            return self.literal(schema["const"])
        if "enum" in schema:
            values = schema["enum"]
            if not isinstance(values, list) or not values:
                raise ValueError(f"enum must be a non-empty array at {owner}{path}")
            return self.union(self.literal(value) for value in values)

        one_of = schema.get("oneOf")
        if isinstance(one_of, list):
            return self.union(self.type_for(value, owner, path) for value in one_of)

        any_of = schema.get("anyOf")
        if isinstance(any_of, list):
            # submit-batch uses anyOf only for minItems constraints on the same
            # object. Those constraints have no distinct static type. If a
            # branch carries an actual type/ref, retain the union instead.
            structural = [
                value
                for value in any_of
                if isinstance(value, dict)
                and any(key in value for key in ("$ref", "type", "oneOf", "enum", "const"))
            ]
            if structural:
                return self.union(self.type_for(value, owner, path) for value in structural)

        types = schema.get("type")
        if isinstance(types, list):
            return self.union(self.primitive_type(value, schema, owner, path) for value in types)
        if isinstance(types, str):
            return self.primitive_type(types, schema, owner, path)

        # A schema with only validation keywords (for example an anyOf branch
        # carrying minItems) does not narrow a static JSON value type.
        return "unknown"

    def primitive_type(self, json_type: Any, schema: dict[str, Any], owner: str, path: str) -> str:
        if json_type == "null":
            return "null" if self.language == "typescript" else "None"
        if json_type == "string":
            return "string" if self.language == "typescript" else "str"
        if json_type == "integer":
            return "number" if self.language == "typescript" else "int"
        if json_type == "number":
            return "number" if self.language == "typescript" else "float"
        if json_type == "boolean":
            return "boolean" if self.language == "typescript" else "bool"
        if json_type == "array":
            items = schema.get("items")
            item_owner = self.child_name(owner, "item")
            item_type = self.type_for(items, item_owner, path + "[]") if items is not None else "unknown"
            return f"Array<{item_type}>" if self.language == "typescript" else f"list[{item_type}]"
        if json_type == "object":
            return self.object_type(schema, owner, path)
        raise ValueError(f"unsupported JSON Schema type {json_type!r} at {owner}{path}")

    def object_type(self, schema: dict[str, Any], owner: str, path: str) -> str:
        properties = schema.get("properties")
        if not isinstance(properties, dict) or not properties:
            additional = schema.get("additionalProperties", True)
            if isinstance(additional, dict):
                value_type = self.type_for(additional, owner, path + "{}")
            else:
                value_type = "unknown" if self.language == "typescript" else "Any"
            return (
                f"Record<string, {value_type}>"
                if self.language == "typescript"
                else f"dict[str, {value_type}]"
            )
        name = self.declaration_for(owner, schema)
        return name

    def literal(self, value: Any) -> str:
        if self.language == "typescript":
            if isinstance(value, bool):
                return "true" if value else "false"
            if value is None:
                return "null"
            if isinstance(value, (int, float)):
                return str(value)
            return json_string(str(value))
        if value is None:
            return "None"
        if isinstance(value, bool):
            return "True" if value else "False"
        if isinstance(value, (int, float)):
            return repr(value)
        return f"Literal[{json_string(str(value))}]"

    def union(self, values: Iterable[str]) -> str:
        values = unique(value for value in values if value)
        if not values:
            return "unknown" if self.language == "typescript" else "Any"
        if self.language == "python":
            values = [value for value in values if value != "None"] + [
                value for value in values if value == "None"
            ]
            if len(values) == 1:
                return values[0]
            return " | ".join(values)
        if len(values) == 1:
            return values[0]
        return " | ".join(values)

    def ordered_declarations(self) -> list[tuple[str, dict[str, Any]]]:
        # Register roots first; recursively discovered child declarations are
        # then emitted in discovery order. This keeps output stable and easy to
        # review while still preserving schema property order.
        for filename in EXPECTED_SCHEMAS:
            self.register(self.root_names[filename], self.schemas[filename])
        index = 0
        while index < len(self.declaration_order):
            name = self.declaration_order[index]
            schema = self.declarations[name]
            self.collect_children(name, schema)
            index += 1
        return [(name, self.declarations[name]) for name in self.declaration_order]

    def collect_children(self, owner: str, schema: dict[str, Any]) -> None:
        if "$ref" in schema:
            return
        for variant_key in ("oneOf", "anyOf", "allOf"):
            variants = schema.get(variant_key)
            if isinstance(variants, list):
                for variant in variants:
                    if isinstance(variant, dict):
                        self.collect_children(owner, variant)
        defs = schema.get("$defs")
        if isinstance(defs, dict):
            for definition, definition_schema in defs.items():
                if isinstance(definition_schema, dict):
                    self.register(f"{owner}{pascal(definition)}", definition_schema)
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for key, property_schema in properties.items():
                if not isinstance(property_schema, dict):
                    continue
                child_owner = self.child_name(owner, key)
                self.type_for(property_schema, child_owner, f".{key}")
                self.collect_inline(child_owner, property_schema)
        items = schema.get("items")
        if isinstance(items, dict):
            self.collect_inline(self.child_name(owner, "item", ""), items)

    def collect_inline(self, owner: str, schema: dict[str, Any]) -> None:
        if "$ref" in schema:
            return
        for key in ("oneOf", "anyOf", "allOf"):
            variants = schema.get(key)
            if isinstance(variants, list):
                for variant in variants:
                    if isinstance(variant, dict):
                        self.type_for(variant, owner)
        if schema.get("type") == "object" and isinstance(schema.get("properties"), dict) and schema.get("properties"):
            self.register(owner, schema)
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for key, property_schema in properties.items():
                if isinstance(property_schema, dict):
                    child_owner = self.child_name(owner, key)
                    self.type_for(property_schema, child_owner)
                    self.collect_inline(child_owner, property_schema)
        items = schema.get("items")
        if isinstance(items, dict):
            item_owner = self.child_name(owner, "item")
            self.type_for(items, item_owner)
            self.collect_inline(item_owner, items)

    def field_entries(self, owner: str, schema: dict[str, Any]) -> list[tuple[str, str, bool]]:
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return []
        required = set(schema.get("required", []))
        entries: list[tuple[str, str, bool]] = []
        for key, property_schema in properties.items():
            if not isinstance(key, str) or not WIRE_NAME.fullmatch(key):
                raise ValueError(f"wire property {key!r} in {owner} is not snake_case")
            if not isinstance(property_schema, dict):
                raise ValueError(f"invalid property schema {owner}.{key}")
            child_owner = self.child_name(owner, key)
            entries.append((key, self.type_for(property_schema, child_owner, f".{key}"), key in required))
        return entries


def render_typescript(schemas: dict[str, dict[str, Any]]) -> str:
    model = TypeModel(schemas, "typescript")
    declarations = model.ordered_declarations()
    lines = [
        "/*",
        " * GENERATED FILE — DO NOT EDIT.",
        " * Source of truth: packages/schema/contracts/*.schema.json",
        " * Generator: scripts/generate_protocol_types.py",
        " * Wire property names are intentionally preserved as snake_case.",
        " */",
        "",
        'export type ProtocolVersion = "0.1";',
        "",
    ]
    for name, schema in declarations:
        if isinstance(schema.get("type"), str) and schema.get("type") == "object":
            entries = model.field_entries(name, schema)
            if entries:
                lines.append(f"export interface {name} {{")
                for key, value, required in entries:
                    optional = "" if required else "?"
                    lines.append(f"  {key}{optional}: {value};")
                additional = schema.get("additionalProperties", True)
                if additional is True or additional is None:
                    lines.append("  [key: string]: unknown;")
                elif isinstance(additional, dict):
                    value = model.type_for(additional, name, ".<additional>")
                    lines.append(f"  [key: string]: {value};")
                lines.append("}")
            else:
                lines.append(
                    f"export type {name} = {model.object_type(schema, name, '')};"
                )
        else:
            lines.append(f"export type {name} = {model.type_for(schema, name)};")
        lines.append("")

    for filename in EXPECTED_SCHEMAS:
        root = model.root_names[filename]
        for alias in schema_aliases(filename, root):
            lines.append(f"export type {alias} = {root};")
    lines.append("")
    return "\n".join(lines)


def render_python(schemas: dict[str, dict[str, Any]]) -> str:
    model = TypeModel(schemas, "python")
    declarations = model.ordered_declarations()
    lines = [
        "\"\"\"Generated Agent Feed protocol types; do not edit.\"\"\"",
        "",
        "# Source of truth: packages/schema/contracts/*.schema.json",
        "# Generator: scripts/generate_protocol_types.py",
        "# Wire property names are intentionally preserved as snake_case.",
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any, Literal, NotRequired, TypedDict",
        "",
        'PROTOCOL_VERSION = "0.1"',
        'ProtocolVersion = Literal["0.1"]',
        "",
    ]
    all_names: list[str] = ["PROTOCOL_VERSION", "ProtocolVersion"]
    for name, schema in declarations:
        if isinstance(schema.get("type"), str) and schema.get("type") == "object":
            entries = model.field_entries(name, schema)
            if entries:
                lines.append(f"class {name}(TypedDict):")
                for key, value, required in entries:
                    type_text = value if required else f"NotRequired[{value}]"
                    lines.append(f"    {key}: {type_text}")
                lines.append("")
            else:
                lines.append(f"{name} = dict[str, Any]")
                lines.append("")
        else:
            lines.append(f"{name} = {model.type_for(schema, name)}")
            lines.append("")
        all_names.append(name)

    for filename in EXPECTED_SCHEMAS:
        root = model.root_names[filename]
        for alias in schema_aliases(filename, root):
            lines.append(f"{alias} = {root}")
            all_names.append(alias)
    lines.extend(["", "__all__ = [", *[f"    {json_string(name)}," for name in all_names], "]", ""])
    return "\n".join(lines)


def render_manifest(schemas: dict[str, dict[str, Any]]) -> str:
    manifest = {
        "generator": "scripts/generate_protocol_types.py",
        "protocol_version": "0.1",
        "schemas": [
            {
                "file": name,
                "id": schemas[name].get("$id"),
                "typescript_root": schema_root_name(name),
                "python_root": schema_root_name(name),
            }
            for name in EXPECTED_SCHEMAS
        ],
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def outputs(schemas: dict[str, dict[str, Any]]) -> dict[Path, str]:
    return {
        TYPESCRIPT_OUTPUT: render_typescript(schemas),
        PYTHON_OUTPUT: render_python(schemas),
        MANIFEST_OUTPUT: render_manifest(schemas),
    }


def write_outputs(rendered: dict[Path, str]) -> None:
    for path, content in rendered.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"Wrote {path.relative_to(BASE)}")


def check_outputs(rendered: dict[Path, str]) -> int:
    failures: list[str] = []
    for path, expected in rendered.items():
        if not path.exists():
            failures.append(f"missing {path.relative_to(BASE)}")
            continue
        actual = path.read_text(encoding="utf-8")
        if actual != expected:
            failures.append(f"stale {path.relative_to(BASE)}")
    if failures:
        print("Protocol type drift detected:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        print("Run: python scripts/generate_protocol_types.py --write", file=sys.stderr)
        return 1
    print(f"Verified generated protocol types ({len(rendered)} artifacts)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="write generated artifacts")
    group.add_argument("--check", action="store_true", help="fail when artifacts differ")
    args = parser.parse_args()
    try:
        schemas = load_schemas()
        rendered = outputs(schemas)
        if args.write:
            write_outputs(rendered)
            return 0
        return check_outputs(rendered)
    except Exception as exc:
        print(f"Protocol type generation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
