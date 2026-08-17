#!/usr/bin/env python3
"""Check Agent Feed protocol compatibility and generated-type drift.

The checked-in baseline records the protocol-0.1 wire shape without
documentation-only JSON Schema keywords.  The check is intentionally
conservative: changing an existing field's type or validation constraint,
removing a required field, or adding a required field is breaking.  Adding an
optional field is allowed by the compatibility policy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from generate_protocol_types import (
    BASE,
    EXPECTED_SCHEMAS,
    check_outputs,
    load_schemas,
    outputs,
)


BASELINE = BASE / "packages/schema/compatibility/protocol-0.1.baseline.json"
WIRE_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
META_KEYS = {"$schema", "$id", "title", "description", "$comment", "examples"}


def semantic_view(value: Any, key: str = "") -> Any:
    """Strip non-contract metadata and canonicalize order-insensitive arrays."""

    if isinstance(value, dict):
        return {
            name: semantic_view(value[name], name)
            for name in sorted(value)
            if name not in META_KEYS
        }
    if isinstance(value, list):
        values = [semantic_view(item) for item in value]
        if key in {"required", "enum", "type"}:
            return sorted(values, key=lambda item: json.dumps(item, sort_keys=True))
        return values
    return value


def baseline_document(schemas: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "protocol_version": "0.1",
        "schemas": {
            name: semantic_view(schemas[name]) for name in EXPECTED_SCHEMAS
        },
    }


def check_wire_names(value: Any, path: str = "") -> list[str]:
    failures: list[str] = []
    if isinstance(value, dict):
        properties = value.get("properties")
        if isinstance(properties, dict):
            for name in properties:
                if not isinstance(name, str) or not WIRE_NAME.fullmatch(name):
                    failures.append(f"{path or '<root>'}.properties.{name!r} is not snake_case")
                failures.extend(check_wire_names(properties[name], f"{path}.properties.{name}"))
        for key, child in value.items():
            if key != "properties":
                failures.extend(check_wire_names(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            failures.extend(check_wire_names(child, f"{path}[{index}]"))
    return failures


def _same(value: Any, other: Any) -> bool:
    return value == other


def breaking_diffs(old: Any, new: Any, path: str = "<root>") -> list[str]:
    """Return conservative breaking changes from ``old`` to ``new``.

    Optional property additions are the one intentional exception: consumers
    may ignore an unknown optional field and producers need not send it.
    Everything that changes an existing constraint is treated as breaking so a
    protocol meaning cannot silently drift under version 0.1.
    """

    failures: list[str] = []
    if not isinstance(old, dict) or not isinstance(new, dict):
        return [] if _same(old, new) else [f"{path}: schema value changed"]

    # Validation keywords and references have contract meaning. A keyword's
    # addition/removal is a change even when it widens rather than narrows the
    # accepted JSON values.
    special = {"properties", "required", "items", "$defs"}
    keys = (set(old) | set(new)) - special
    for key in sorted(keys):
        if key not in old or key not in new or not _same(old[key], new[key]):
            failures.append(f"{path}.{key}: validation/reference constraint changed")

    old_required = set(old.get("required", [])) if isinstance(old.get("required"), list) else set()
    new_required = set(new.get("required", [])) if isinstance(new.get("required"), list) else set()
    for name in sorted(old_required - new_required):
        failures.append(f"{path}.required: removed required field {name!r}")
    for name in sorted(new_required - old_required):
        failures.append(f"{path}.required: added required field {name!r}")

    old_properties = old.get("properties", {})
    new_properties = new.get("properties", {})
    if not isinstance(old_properties, dict):
        old_properties = {}
    if not isinstance(new_properties, dict):
        new_properties = {}
    for name in sorted(set(old_properties) & set(new_properties)):
        failures.extend(
            breaking_diffs(old_properties[name], new_properties[name], f"{path}.properties.{name}")
        )
    # Removing an optional field and adding an optional field are compatible;
    # required removals/additions were already reported above.

    if "items" in old or "items" in new:
        if "items" not in old or "items" not in new:
            failures.append(f"{path}.items: array item constraint changed")
        else:
            failures.extend(breaking_diffs(old["items"], new["items"], f"{path}.items"))

    old_defs = old.get("$defs", {})
    new_defs = new.get("$defs", {})
    if not isinstance(old_defs, dict):
        old_defs = {}
    if not isinstance(new_defs, dict):
        new_defs = {}
    for name in sorted(set(old_defs) - set(new_defs)):
        failures.append(f"{path}.$defs: removed definition {name!r}")
    for name in sorted(set(old_defs) & set(new_defs)):
        failures.extend(breaking_diffs(old_defs[name], new_defs[name], f"{path}.$defs.{name}"))
    return failures


def check_protocol(schemas: dict[str, dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    for filename in EXPECTED_SCHEMAS:
        schema = schemas[filename]
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            failures.append(f"{filename}: must declare Draft 2020-12")
        properties = schema.get("properties")
        if isinstance(properties, dict) and "protocol_version" in properties:
            version = properties["protocol_version"]
            if not isinstance(version, dict) or version.get("const") != "0.1":
                failures.append(f"{filename}: protocol_version must be const 0.1")
        failures.extend(check_wire_names(schema, filename))
    return failures


def write_baseline(schemas: dict[str, dict[str, Any]]) -> int:
    BASELINE.parent.mkdir(parents=True, exist_ok=True)
    BASELINE.write_text(
        json.dumps(baseline_document(schemas), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {BASELINE.relative_to(BASE)}")
    return 0


def check_baseline(schemas: dict[str, dict[str, Any]]) -> list[str]:
    if not BASELINE.exists():
        return [f"missing {BASELINE.relative_to(BASE)} (run --write-baseline intentionally)"]
    try:
        baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"invalid compatibility baseline: {exc}"]
    if baseline.get("protocol_version") != "0.1":
        return ["compatibility baseline is not for protocol 0.1"]
    old_schemas = baseline.get("schemas")
    if not isinstance(old_schemas, dict):
        return ["compatibility baseline has no schema map"]
    current = baseline_document(schemas)["schemas"]
    failures: list[str] = []
    for name in EXPECTED_SCHEMAS:
        if name not in old_schemas:
            failures.append(f"baseline missing schema {name}")
        elif name in current:
            failures.extend(breaking_diffs(old_schemas[name], current[name], name))
    for name in sorted(set(old_schemas) - set(EXPECTED_SCHEMAS)):
        failures.append(f"baseline contains unknown schema {name}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="write the current schema shape as the protocol-0.1 baseline",
    )
    args = parser.parse_args()
    try:
        schemas = load_schemas()
        protocol_failures = check_protocol(schemas)
        if protocol_failures:
            for failure in protocol_failures:
                print(f"Protocol compatibility failed: {failure}", file=sys.stderr)
            return 1
        if args.write_baseline:
            return write_baseline(schemas)

        drift_status = check_outputs(outputs(schemas))
        baseline_failures = check_baseline(schemas)
        if baseline_failures:
            for failure in baseline_failures:
                print(f"Protocol compatibility failed: {failure}", file=sys.stderr)
            return 1
        if drift_status:
            return drift_status
        print("Protocol 0.1 compatibility and generated-type drift checks passed")
        return 0
    except Exception as exc:
        print(f"Protocol compatibility check failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
