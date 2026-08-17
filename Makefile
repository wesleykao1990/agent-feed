.PHONY: validate checksums
validate:
	python scripts/validate_package.py
checksums:
	python scripts/generate_checksums.py --check
