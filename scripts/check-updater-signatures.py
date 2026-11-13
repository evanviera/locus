"""Fail if any updater .sig was made with a key the app doesn't trust.

Installed copies only accept updates signed by the key whose public half is in
src-tauri/tauri.conf.json (plugins.updater.pubkey). A release signed with any
other key installs from the website but can never auto-update existing users,
so the Release workflow runs this before publishing.

Usage: python3 scripts/check-updater-signatures.py <file.sig>...
"""
import base64
import json
import sys


def key_id(minisign_b64_file: str) -> str:
    # Tauri wraps a minisign file in base64; line 2 of it holds the key id
    # (bytes 2..10, little-endian) for both public keys and signatures.
    text = base64.b64decode(minisign_b64_file).decode()
    raw = base64.b64decode(text.splitlines()[1])
    return raw[2:10][::-1].hex().upper()


def main() -> int:
    with open("src-tauri/tauri.conf.json") as f:
        trusted = key_id(json.load(f)["plugins"]["updater"]["pubkey"])
    bad = []
    for path in sys.argv[1:]:
        with open(path) as f:
            signed = key_id(f.read().strip())
        print(f"{path}: signed by {signed}")
        if signed != trusted:
            bad.append(path)
    if not sys.argv[1:]:
        print("No .sig files to check.")
        return 1
    if bad:
        print(f"\nThe app trusts updater key {trusted}, but these were signed with another key:")
        print("\n".join(f"  {p}" for p in bad))
        print("Set TAURI_SIGNING_PRIVATE_KEY to the key that matches the pubkey in tauri.conf.json.")
        return 1
    print(f"All signatures match the trusted updater key {trusted}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
