<!-- generated-by: gsd-doc-writer -->
# @platform/dashboard

React/Vite client for Parrot's structured workflow read models. It displays
workflow state, objections, frontier readiness, escalation, and cost, and posts
human approval/rejection decisions.

## Development

```bash
pnpm --filter @platform/dashboard dev
```

The dev server listens on `127.0.0.1:5173` and proxies `/api` to
`http://127.0.0.1:8787`. An embedding process must start
`createDashboardApi` from `@platform/human-loop`; the Vite command starts only
the client.

## Build

```bash
pnpm --filter @platform/dashboard build
pnpm --filter @platform/dashboard preview
```

This package does not currently define an automated test script. Keep data
access in the versioned human-loop read-model/API layer and render untrusted
claims as React text nodes.
