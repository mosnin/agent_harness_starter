# 07 — Deployment

---

## Vercel (recommended for Next.js)

### Streaming requires `runtime = "nodejs"`

All agent route files must export this — it's already included in `routes/agent/route.ts` and `routes/mcp/route.ts`:

```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

Vercel's Edge Runtime does not support the node: APIs used by `@openai/agents` and `playwright`.

### Function timeout

Default Vercel function timeout is 10s (Hobby) or 60s (Pro). Agents commonly take longer. Increase it:

```typescript
// routes/agent/route.ts
export const maxDuration = 300; // 5 minutes — requires Pro plan
```

Or in `vercel.json`:
```json
{
  "functions": {
    "src/app/api/agent/route.ts": { "maxDuration": 300 },
    "src/app/api/mcp/route.ts": { "maxDuration": 60 }
  }
}
```

### Environment variables

Add all variables from `.env.example` to your Vercel project:
```bash
vercel env add OPENAI_API_KEY production
vercel env add TAVILY_API_KEY production
# ... etc
```

### Streaming on Vercel

Vercel supports streaming out of the box for Nodejs runtime. The SSE response from `/api/agent` streams to the browser correctly. No additional configuration needed.

---

## Railway / Render / Fly.io

These platforms run your Next.js app as a long-running Node.js process, which is ideal for agents (no timeout limits, full Node.js compatibility).

### Dockerfile

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["npm", "start"]
```

### Health check endpoint

Add a simple health check for load balancers:

```typescript
// src/app/api/health/route.ts
export async function GET() {
  return Response.json({ status: "ok", timestamp: new Date().toISOString() });
}
```

---

## Browser tools in production

Local Playwright requires Chrome to be installed. In containerized environments:

### Option A: Use Browserbase (recommended for production)

```bash
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
```

No browser installation needed. Browserbase provides parallel, managed browser sessions.

### Option B: Install Chromium in Docker

```dockerfile
RUN apk add --no-cache chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

```typescript
// In browser.ts, for headless Chromium:
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
```

---

## Sandbox execution in production

### Daytona

Daytona runs on their cloud or self-hosted. In production:
```bash
SANDBOX_PROVIDER=daytona
DAYTONA_API_KEY=...
DAYTONA_SERVER_URL=https://app.daytona.io/api
```

### Modal

Modal requires authentication before deployment:
```bash
# On your deployment server or in CI:
modal token set --token-id $MODAL_TOKEN_ID --token-secret $MODAL_TOKEN_SECRET
```

Or use environment variables directly:
```bash
SANDBOX_PROVIDER=modal
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

---

## Database migrations in CI/CD

### Supabase

```yaml
# .github/workflows/deploy.yml
- name: Run Supabase migrations
  run: npx supabase db push
  env:
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
```

### Prisma

```yaml
- name: Run Prisma migrations
  run: npx prisma migrate deploy
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

### Convex

```yaml
- name: Deploy Convex functions
  run: npx convex deploy --cmd "npm run build"
  env:
    CONVEX_DEPLOY_KEY: ${{ secrets.CONVEX_DEPLOY_KEY }}
```

---

## Secrets management

Never commit `.env.local`. For production secrets:

| Platform | Tool |
|---|---|
| Vercel | Dashboard → Settings → Environment Variables |
| Railway | Dashboard → Variables |
| AWS | Secrets Manager + `@aws-sdk/client-secrets-manager` |
| GCP | Secret Manager |
| Self-hosted | HashiCorp Vault, Doppler, or `dotenv-vault` |

---

## Monitoring agents in production

### Key metrics to track

- **Agent run success rate** — `status: "completed"` vs `"failed"` in `agent_runs` table
- **P50/P95 run duration** — from `startedAt` to `completedAt`
- **Tool call frequency** — which tools are called most, which fail most
- **Token usage** — from OpenAI API response headers or usage objects
- **Cancellation rate** — runs that end with `AbortError`

### Simple dashboard query (Supabase/Postgres)

```sql
-- Last 24h agent run stats
SELECT
  agent_name,
  COUNT(*) AS total_runs,
  COUNT(*) FILTER (WHERE status = 'completed') AS successful,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) AS avg_duration_sec
FROM agent_runs
WHERE started_at > NOW() - INTERVAL '24 hours'
GROUP BY agent_name
ORDER BY total_runs DESC;
```

### Error alerting

```typescript
// In harness.ts, after a failed run:
if (event.type === "error") {
  // Send to your alerting system
  await fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    body: JSON.stringify({
      text: `🚨 Agent error: ${agentConfig.name}\nUser: ${input.context?.userId}\nError: ${event.error}`,
    }),
  });
}
```

---

## Rate limiting the agent endpoint

Add rate limiting to `/api/agent` to protect OpenAI quota and control costs:

```typescript
// Using upstash/ratelimit (works on Vercel Edge and Node):
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 h"),  // 10 runs per hour per user
});

// In POST /api/agent:
const { success, remaining } = await ratelimit.limit(user.id);
if (!success) {
  return Response.json(
    { error: `Rate limit exceeded. Try again later.` },
    { status: 429, headers: { "X-RateLimit-Remaining": String(remaining) } }
  );
}
```

---

## Cost controls

### Per-user monthly spending cap

Track token usage and block users who exceed their plan's allocation:

```typescript
// After each agent run, record token usage:
await db.recordTokenUsage({
  userId,
  month: new Date().toISOString().slice(0, 7), // "2025-05"
  tokens: runResult.usage?.totalTokens ?? 0,
});

// At the start of each run, check:
const monthlyUsage = await db.getMonthlyTokenUsage(userId);
const monthlyLimit = await getPlanTokenLimit(userId);
if (monthlyUsage > monthlyLimit) {
  return Response.json({ error: "Monthly AI usage limit reached. Upgrade your plan." }, { status: 402 });
}
```

### Model cost reference (approximate, check current OpenAI pricing)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| o3-mini | $1.10 | $4.40 |
