# Vercel runtime pin

The production MCP deployment pins Node.js to 22.x and pnpm to 10.15.1. Vercel must not float the build to a future Node major because Corepack/pnpm registry requests have failed under newer runtimes with `ERR_INVALID_THIS` / `URLSearchParams` errors.

The Vercel install command intentionally invokes the pinned pnpm version directly with `npx` rather than relying on the platform-bundled Corepack shim.
