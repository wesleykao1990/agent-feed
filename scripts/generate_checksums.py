#!/usr/bin/env python3
"""Deprecated compatibility shim.

Agent Feed no longer uses repository-wide checksum manifests as a CI gate.
This script remains temporarily so older local commands and stale workflow
references do not fail while callers migrate away from checksums:check/write.
"""
from __future__ import annotations

import argparse


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.parse_args()
    print("Agent Feed repository checksum gating is retired; no checksum verification is performed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
