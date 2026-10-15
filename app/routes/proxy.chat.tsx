import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runHvacAgent, sanitizeHistory } from "../lib/hvac-ai/agent.server";
import { rateLimit } from "../lib/hvac-ai/rate-limit.server";

/**
 * Storefront endpoint, reached through the Shopify app proxy:
 *   POST https://hvacmore.com/apps/hvac-ai/chat
 * Shopify signs every proxied request; authenticate.public.appProxy
 * verifies the HMAC so nobody can hit this endpoint directly.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  return json({ ok: Boolean(session), app: "HVAC AI" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) {
    return json({ error: "HVAC AI is not installed on this store." }, 401);
  }

  const url = new URL(request.url);
  const visitor =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    url.searchParams.get("logged_in_customer_id") ||
    "anon";
  const limit = rateLimit(`${session.shop}:${visitor}`);
  if (!limit.ok) {
    return json(
      { error: `You've asked a lot of questions in a short time. Try again in ${Math.ceil(limit.retryAfter / 60)} min.` },
      429,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const messages = sanitizeHistory(body.messages);
  if (!messages.length) return json({ error: "Ask a question first." }, 400);

  const productHandle =
    typeof body.productHandle === "string" && /^[a-z0-9-]{1,255}$/i.test(body.productHandle)
      ? body.productHandle
      : null;
  const collectionTitle =
    typeof body.collectionTitle === "string" ? body.collectionTitle.slice(0, 120) : null;

  try {
    const result = await runHvacAgent({
      admin,
      shop: session.shop,
      messages,
      productHandle,
      collectionTitle,
    });
    return json(result);
  } catch (err) {
    console.error("HVAC AI agent error", err);
    return json(
      { error: "HVAC AI is having trouble right now. Please try again or call us." },
      500,
    );
  }
};
