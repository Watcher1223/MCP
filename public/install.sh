#!/bin/bash
# Synapse Install Script
# Usage: curl -fsSL https://synapse.clodhost.com/install.sh | bash

set -e

SYNAPSE_VERSION="2.0.0"
SYNAPSE_HUB="${SYNAPSE_HUB:-wss://synapse.clodhost.com}"

echo ""
echo "🧠 Installing Synapse v${SYNAPSE_VERSION}..."
echo ""

# Detect OS
OS="$(uname -s)"
ARCH="$(uname -m)"

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo ""
    echo "Install Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ is required. Found: $(node -v)"
    exit 1
fi

# Install via npx (auto-downloads and runs)
echo "📦 Running Synapse CLI..."
echo ""

# Create config directory
mkdir -p ~/.synapse

# Run the connect command
npx synapse@latest connect "$@"

echo ""
echo "✅ Synapse installed and connected!"
echo ""
echo "Commands:"
echo "  synapse status    - Check connection status"
echo "  synapse agents    - List all agents"
echo "  synapse daemon    - Run as background service"
echo ""
echo "Dashboard: https://synapse.clodhost.com"
echo ""
