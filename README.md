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

## Docker

The repository includes a production multi-stage Dockerfile. It builds Next.js in standalone mode and runs the generated server on Railway's `$PORT` (3000 locally).

```bash
docker build -t groupproof .
docker run --rm -p 3000:3000 groupproof
```

The container exposes `/healthz` for platform health checks.

## CI/CD and Railway

`.github/workflows/ci-cd.yml` runs lint, TypeScript checks, route checks, a production build, a rendered-route smoke test, and a Docker build/smoke test for pull requests and pushes to `main` or `develop`.

Railway detects the root `Dockerfile`; configure the service health check as `/healthz` in the dashboard. Environment variables are documented in [`.env.example`](./.env.example); the staging/production service layout is documented in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

To use Railway's GitHub integration for automatic deployment:

1. Create separate staging and production Railway projects and connect `develop` to staging and `main` to production.
2. Keep the service root directory at the repository root. Railway will detect `Dockerfile` automatically.
3. Set the service health check path to `/healthz`, then generate a Railway domain.
4. Protect `main` and `develop` in GitHub and require the quality and Docker checks before merging. Railway will redeploy pushes to the connected branch. A direct push can trigger Railway before that push's Actions checks finish.

For deployments gated by this workflow's checks, disable Railway's automatic GitHub deployment and use the Actions deploy job instead. Create GitHub Environments named `staging` and `production`; in each environment add the target Railway Project Token as the `RAILWAY_TOKEN` secret and the target service ID as the `RAILWAY_SERVICE_ID` variable. Set the repository variable `RAILWAY_DEPLOY_STAGING` or `RAILWAY_DEPLOY_PRODUCTION` to `true` to enable automatic deployment for that branch. A push to `develop` or `main` then runs the matching deploy job after the checks pass; a manual workflow run can deploy a selected ref. Use one deployment trigger to avoid duplicate deployments.

This V1 is still a browser-only mock frontend. It does not require runtime environment variables, and data stored in `localStorage` is local to each browser rather than shared by Railway instances.

The planned frontend/API/worker boundaries, environment variable contract, and staging/production rollout rules are documented in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Current scope

The 56 design pages, navigation, forms, and core mock interactions are present. Authentication, email verification, AI, GitHub, Feishu, file storage, and report export use mock implementations. See [frontend status](FRONTEND_STATUS.md) for implementation details and known limitations.
