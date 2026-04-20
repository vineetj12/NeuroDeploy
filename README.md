# NeuroDeploy

NeuroDeploy is an automated deployment-fix platform.

Current workspace status:
- backend is implemented and active
- frontend folder exists but is currently empty

## What Is Built

Backend features already implemented in [backend](backend):
- Express API with health endpoints
- User create/update endpoints
- Vercel project endpoints and webhook ingestion
- Prisma + PostgreSQL data layer
- BullMQ queue for async fix jobs
- Worker that generates fixes with AI, validates with Docker, pushes to GitHub, and opens PRs

## Architecture

```text
Clients / Webhooks
        |
        v
backend/src/index.ts (Express)
        |
        +--> /api/user    -> router/user.ts -> controller/user -> Prisma
        |
        +--> /api/vercel  -> router/vercel.ts -> controller/vercel
                                      |            |
                                      |            +--> enqueue BullMQ job
                                      |
                                      +--> vercelwebhook.ts decision flow
                                                |
                                                +--> queue on deployment ERROR

BullMQ Queue: fix-project-queue
        |
        v
backend/src/worker/fixProjectWorker.ts
        |
        +--> load DB credentials (GitHub/Vercel/model)
        +--> fetch deployment logs from Vercel API
        +--> clone repository from GitHub
        +--> ask selected AI provider for code changes
        +--> apply patch and validate with Docker
        +--> push branch and create PR
```

## Repository Structure

```text
NeuroDeploy/
  backend/
    prisma/
    src/
    package.json
    tsconfig.json
  frontend/
  README.md
```

## Backend Quick Start

```bash
cd backend
npm install
```

Run API:

```bash
npm run dev
```

Run worker:

```bash
npm run dev:worker
```

## Backend Environment Variables

Configured in [backend/src/envdata/data.ts](backend/src/envdata/data.ts):
- PORT (default 4000)
- REDIS_URL (default redis://127.0.0.1:6379)
- GEMINI_API_KEY
- GEMINI_MODEL (default gemini-2.5-flash)
- DATABASE_URL (required by Prisma)

## API Summary

Base routes (backend):
- GET /api/health
- GET /health
- POST /api/user/create
- PATCH /api/user/:id
- GET /api/vercel/projects
- GET /api/vercel/projects/:id
- POST /api/vercel/projects/:id/fix
- POST /api/vercel/webhook

## Notes

- Worker currently relies on user-scoped credentials stored in DB.
- Docker must be running for validation inside the worker flow.
