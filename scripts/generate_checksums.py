#!/usr/bin/env python3
from __future__ import annotations
import argparse, sys
from hashlib import sha256
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
OUT=BASE/'SHA256SUMS.txt'
EXCLUDED={OUT.name}
IGNORED={'__pycache__','.git','.pytest_cache','.mypy_cache','.ruff_cache','node_modules','dist','artifacts','.build-src','.runtime','.venv'}
REQUIRED_PRIVATE_IGNORES={'.git','.runtime','.venv','node_modules'}
def ignored(p):
 return any(x in IGNORED for x in p.parts) or p.name=='.env' or (p.name.startswith('.env.') and p.name!='.env.example')
def assert_safe_inventory():
 missing=REQUIRED_PRIVATE_IGNORES-IGNORED
 if missing: raise RuntimeError(f'unsafe checksum inventory missing private ignores: {sorted(missing)}')
def files():
 assert_safe_inventory()
 return sorted(p for p in BASE.rglob('*') if p.is_file() and p.name not in EXCLUDED and not ignored(p))
def digest(p): return sha256(p.read_bytes()).hexdigest()
def rows(): return {p.relative_to(BASE).as_posix():digest(p) for p in files()}
def write():
 r=rows(); OUT.write_text(''.join(f'{v}  {k}\n' for k,v in sorted(r.items())), encoding='utf-8'); print(f'Wrote {len(r)} checksums'); return 0
def check():
 if not OUT.exists(): print('Missing SHA256SUMS.txt', file=sys.stderr); return 1
 exp={}
 for line in OUT.read_text(encoding='utf-8').splitlines():
  if not line.strip(): continue
  h,n=line.split('  ',1); exp[n]=h
 private=[n for n in exp if ignored(Path(n))]
 if private:
  print(f'Unsafe private paths in checksum inventory: {sorted(private)}', file=sys.stderr); return 1
 act=rows(); bad=[n for n in set(exp)&set(act) if exp[n]!=act[n]]
 if set(exp)!=set(act) or bad:
  print(f'Checksum mismatch missing={sorted(set(exp)-set(act))} untracked={sorted(set(act)-set(exp))} bad={sorted(bad)}', file=sys.stderr); return 1
 print(f'Verified {len(act)} checksums without modifying {OUT}'); return 0
def main():
 ap=argparse.ArgumentParser(); g=ap.add_mutually_exclusive_group(required=True); g.add_argument('--write',action='store_true'); g.add_argument('--check',action='store_true'); a=ap.parse_args(); return write() if a.write else check()
if __name__=='__main__': raise SystemExit(main())
