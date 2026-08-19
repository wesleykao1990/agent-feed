.PHONY: validate checksums types compatibility conformance setup doctor m5
validate:
	python scripts/validate_package.py
checksums:
	python scripts/generate_checksums.py --check
types:
	python3 scripts/generate_protocol_types.py --check
compatibility:
	python3 scripts/check_protocol_compatibility.py
conformance:
	npm run conformance:test
setup:
	bin/agent-feed setup
doctor:
	bin/agent-feed doctor
m5:
	npm run m5:conformance
