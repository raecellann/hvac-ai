# HVAC AI — Parts diagnostic assistant for HVAC MORE

A Shopify app that adds an AI "master mechanic" to the **Parts** collection page and to
every parts product page on hvacmore.com. Shoppers describe a symptom or a meter reading;
HVAC AI answers diagnostic-style (likely fault → exact readings to take → what each result
means → one next question), then links the matching in-stock parts.

## How it works

```
Storefront block (theme app extension)
   │  POST /apps/hvac-ai/chat   (Shopify app proxy, HMAC-signed)
   ▼
app/routes/proxy.chat.tsx  ──►  app/lib/hvac-ai/agent.server.ts  ──►  Claude API (tool use)
                                         │
                                         └─ search_parts / get_part  ──►  Admin GraphQL
                                            (every result checked with inCollection(Parts))
```

- **Parts-only:** every product the agent can see is verified with `inCollection` against the
  collection in `PARTS_COLLECTION_HANDLE` (default `parts`). Condensers, systems, etc. never come back.
- **No invented SKUs or prices:** the model can only recommend handles returned by the tools.
- **Answer style** lives in `app/lib/hvac-ai/prompt.server.ts`. `[[value]]` renders as a blue chip,
  `**text**` as bold.
- **Product context:** on a PDP the block sends the product handle; the agent loads that part's
  specs so "how do I test this?" works.
- Rate limit: 20 questions / 10 min per visitor (`rate-limit.server.ts`, in-memory).
- Hosting: Render Starter instance + 1 GB disk (stores Shopify sessions in SQLite at `/data`).

## Files you'll touch

| File | What |
|---|---|
| `app/lib/hvac-ai/prompt.server.ts` | Persona, answer format, safety rules |
| `app/lib/hvac-ai/agent.server.ts` | Claude tool-use loop |
| `app/lib/hvac-ai/parts.server.ts` | Catalog search, Parts-collection guard |
| `app/routes/proxy.chat.tsx` | Storefront endpoint (app proxy) |
| `app/routes/app._index.tsx` | Admin: status + test console |
| `extensions/hvac-ai-chat/` | Theme app block, JS, CSS |

## Secrets — what is and isn't in this repo

Nothing secret is committed. `.env`, `.env.*` (except `.env.example`), SQLite databases, `*.pem`
and `*.key` are git-ignored. All secrets live in Render → Environment:

| Variable | Where it comes from | Secret? |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com | **Yes** |
| `SHOPIFY_API_SECRET` | Dev Dashboard → your app → Settings → Client secret | **Yes** |
| `SHOPIFY_API_KEY` | Same page → Client ID | No (public) |
| `SHOPIFY_APP_URL` | Your Render URL, e.g. `https://hvac-ai.onrender.com` | No |

`client_id` in `shopify.app.toml` is the public Client ID and is safe to commit.

## Deploy (GitHub → Render → Shopify)

You need Node 22+, the Shopify CLI (`npm i -g @shopify/cli`), and a Render account.

1. **Push to GitHub** (make the repo **private**):
   ```bash
   git init && git add . && git commit -m "HVAC AI"
   git remote add origin git@github.com:YOUR-ORG/hvac-ai.git
   git push -u origin main
   ```
   Before pushing, `git status` should show no `.env` file.

2. **Create the Shopify app record:**
   ```bash
   npm install
   shopify app config link     # log in → "Create new app" → name it HVAC AI
   ```
   This fills `client_id` in `shopify.app.toml`. Copy the Client ID + Client secret from the
   Dev Dashboard (dev.shopify.com → Apps → HVAC AI → Settings).

3. **Deploy on Render:** New → **Blueprint** → pick the repo. Render reads `render.yaml` and
   asks for the 4 secret values. For `SHOPIFY_APP_URL`, enter the URL Render shows for the
   service (e.g. `https://hvac-ai.onrender.com`) — you can save it after the first deploy and redeploy.

4. **Point Shopify at Render:** in `shopify.app.toml` replace every `https://example.com` with
   your Render URL (`application_url`, `[app_proxy] url` → `https://YOUR-URL/proxy`, and
   `redirect_urls` → `https://YOUR-URL/api/auth`). Then:
   ```bash
   shopify app deploy          # pushes config + the theme block to Shopify
   git commit -am "Set app URL" && git push
   ```

5. **Install on HVAC MORE:** Dev Dashboard → HVAC AI → **Distribution** → Custom distribution →
   enter `7fbbd9-02.myshopify.com` → open the install link → Install. It now appears under
   **Apps** in the Shopify admin. Open it and use the test console.

6. **Add the chat to the storefront** (on a duplicated draft theme first): Online Store → Themes →
   Customize → Parts collection template → Add block → Apps → **HVAC AI Parts Assistant**.
   Repeat on the product template. Preview, then publish.

## Local development

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm install
npm run dev                 # tunnels to your dev store
```

## Notes

- Scope is `read_products` only.
- If the block doesn't appear on PDPs, the Parts smart collection may not be published to the
  Online Store channel (Liquid's `product.collections` only lists published ones). Publish it, or
  tick "Show on every page this block is added to" — the server still restricts answers to parts.
