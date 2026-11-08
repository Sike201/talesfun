#!/bin/bash
# Build the higher_launchpad Anchor program
# Uses platform-tools v1.52 (Rust 1.89) to support edition2024 deps in the build graph
# then generates the IDL with system Rust

set -e
cd "$(dirname "$0")"

echo "==> Building program binary with platform-tools v1.52..."
cargo build-sbf --tools-version v1.52

echo "==> Building IDL..."
anchor idl build -o target/idl/higher_launchpad.json

echo "==> Syncing program keys..."
anchor keys sync

echo ""
echo "Build complete!"
echo "  Binary: target/deploy/higher_launchpad.so"
echo "  IDL:    target/idl/higher_launchpad.json"
echo "  Program ID: $(anchor keys list 2>/dev/null | grep higher_launchpad | awk '{print $2}')"
