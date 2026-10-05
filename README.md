# GroupProof

GroupProof V1 is a runnable Next.js frontend prototype for group-project collaboration. It currently uses local mock data and browser storage for demonstrations.

## Run locally

Requires Node.js 20 or newer.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The role selector in the app switches between demo student, leader, teacher, teaching assistant, and administrator accounts.

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run check:routes
```

With the development server running, `CHECK_HTTP=1 npm run check:routes` checks all 56 design-page URLs.

## Current scope

The 56 design pages, navigation, forms, and core mock interactions are present. Authentication, email verification, AI, GitHub, Feishu, file storage, and report export use mock implementations. See [frontend status](FRONTEND_STATUS.md) for implementation details and known limitations.
