# NeuroDeploy

NeuroDeploy is an automated deployment-fix platform that monitors your Vercel deployments, analyzes build logs with AI, generates code fixes, validates them in an isolated Docker environment, and automatically opens Pull Requests on GitHub.

## 🚀 What Is Built

### Full-Stack Architecture
- **Frontend (React + Vite + TS)**: A beautiful, modern interface built with the Obsidian Flux design system. Features real-time job status polling, live AI diffs, and project management.
- **Backend (Express + Node + TS)**: A modular API service handling authentication, webhook ingestion, and job queuing.
- **Background Worker**: A BullMQ worker that executes the entire fix pipeline asynchronously.

### Features
- **JWT Authentication**: Secure user registration, login, and protected routes via middleware.
- **Credential Vault**: Secure storage for Vercel tokens, GitHub PATs, and AI Provider API keys.
- **Multiple AI Providers**: Seamless integration with Google Gemini, OpenAI, and Anthropic. Allows dynamic model switching from the dashboard.
- **Real-Time Tracking**: Polling endpoints allow the frontend to display live logs, repair status timelines, and AI-generated code diffs as the worker runs.
- **Automated Validation**: Spawns isolated Docker containers to test the AI-generated code patches before pushing to GitHub.

## 🏗️ Architecture

```text
Clients (Browser) / Vercel Webhooks
        |
        v
backend/src/index.ts (Express API)
        |
        +--> /api/user    (JWT Auth, Credential Management)
        |
        +--> /api/vercel  (Dashboard Projects, Trigger Auto-Fix)
                                      |
                                      +--> enqueue BullMQ job
                                      
BullMQ Queue: fix-project-queue
        |
        v
backend/src/worker/fixProjectWorker.ts
        |
        +--> Load User Credentials (GitHub/Vercel/Model)
        +--> Fetch deployment logs from Vercel API
        +--> Clone repository from GitHub
        +--> Prompt active AI provider (Gemini/OpenAI/Anthropic)
        +--> Apply patch and validate with Docker
        +--> Push branch and create PR
```

## 📂 Repository Structure

```text
NeuroDeploy/
  backend/           (Express API, Prisma DB, BullMQ Worker)
    prisma/          (Postgres Schema)
    src/
    package.json
  frontend/          (React Vite App)
    src/
      components/    (UI Library)
      pages/         (Dashboard, Settings, FixDetails, Auth)
      api/           (JWT Client)
    package.json
```

## ⚡ Quick Start

### 1. Database & Services
Ensure you have **PostgreSQL** and **Redis** running locally.

### 2. Backend Setup
```bash
cd backend
npm install
npx prisma generate
npx prisma db push
```

Start the API Server:
```bash
npm run dev
```

Start the Worker Process:
```bash
npm run dev:worker
```

### 3. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```
Navigate to `http://localhost:5173`. Register an account, go to **Settings**, and add your API keys to get started!

## 🔐 Environment Variables

### Backend (`backend/.env`)
- `PORT` (default 4000)
- `REDIS_URL` (default redis://127.0.0.1:6379)
- `DATABASE_URL` (PostgreSQL connection string)
- `JWT_SECRET` (For authentication signatures)

## 📌 Notes
- The worker uses Docker internally. The Docker daemon must be running on the host machine to validate builds.
- Vercel Webhook integration requires exposing your local server to the internet (e.g., via ngrok) or deploying to production.
