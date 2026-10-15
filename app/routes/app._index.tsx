import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  runHvacAgent,
  sanitizeHistory,
  type AgentReply,
  type ChatMessage,
} from "../lib/hvac-ai/agent.server";
import { PARTS_COLLECTION_HANDLE } from "../lib/hvac-ai/parts.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const res = await admin.graphql(
    `#graphql
    query HvacAiStatus($handle: String!) {
      collectionByIdentifier(identifier: { handle: $handle }) {
        id
        title
        productsCount { count }
      }
    }`,
    { variables: { handle: PARTS_COLLECTION_HANDLE } },
  );
  const { data } = await res.json();

  return {
    shop: session.shop,
    collectionHandle: PARTS_COLLECTION_HANDLE,
    collection: data?.collectionByIdentifier ?? null,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  let raw: unknown = [];
  try {
    raw = JSON.parse(String(form.get("messages") || "[]"));
  } catch {
    /* ignore */
  }
  const messages = sanitizeHistory(raw);
  const productHandle = String(form.get("productHandle") || "").trim() || null;
  if (!messages.length) return { error: "Ask a question first." };
  try {
    const result = await runHvacAgent({
      admin,
      shop: session.shop,
      messages,
      productHandle,
    });
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Agent failed" };
  }
};

type Turn = ChatMessage & { data?: AgentReply };

function renderReply(text: string) {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(
      /\[\[([^\]\n]{1,40})\]\]/g,
      '<span style="background:#e8effb;color:#173f8a;border-radius:6px;padding:0 6px;font-weight:600;white-space:nowrap">$1</span>',
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

export default function Index() {
  const status = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [productHandle, setProductHandle] = useState("");
  const handled = useRef<unknown>(null);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if ("result" in d && d.result) {
      setTurns((t) => [...t, { role: "assistant", content: d.result!.reply, data: d.result }]);
    } else if ("error" in d) {
      setTurns((t) => [...t, { role: "assistant", content: `⚠ ${d.error}` }]);
    }
  }, [fetcher.data]);

  const ask = () => {
    const q = draft.trim();
    if (!q || busy) return;
    const next = [...turns, { role: "user" as const, content: q }];
    setTurns(next);
    setDraft("");
    fetcher.submit(
      {
        messages: JSON.stringify(
          next
            .filter((t) => !t.content.startsWith("⚠"))
            .map(({ role, content }) => ({ role, content })),
        ),
        productHandle,
      },
      { method: "POST" },
    );
  };

  const ready = status.hasApiKey && status.collection;

  return (
    <s-page heading="HVAC AI">
      <s-section heading="Status">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            {status.hasApiKey ? "✅" : "❌"} Claude API key{" "}
            {status.hasApiKey ? `configured (model: ${status.model})` : "missing — set ANTHROPIC_API_KEY on the server"}
          </s-paragraph>
          <s-paragraph>
            {status.collection ? "✅" : "❌"} Parts collection{" "}
            {status.collection
              ? `"${status.collection.title}" — ${status.collection.productsCount?.count?.toLocaleString()} products. Answers are limited to these parts.`
              : `with handle "${status.collectionHandle}" not found — set PARTS_COLLECTION_HANDLE`}
          </s-paragraph>
          <s-paragraph>
            Add it to the storefront: Online Store → Themes → Customize → open the
            Parts collection template (and the product template) → Add block →
            Apps → <strong>HVAC AI Parts Assistant</strong>.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Test console">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Pretend the shopper is viewing this product (optional handle)"
            value={productHandle}
            placeholder="e.g. 16a52-lennox-24v-35-wc-nat-gas-valve"
            onInput={(e) => setProductHandle(e.currentTarget.value)}
          />

          {turns.map((t, i) =>
            t.role === "user" ? (
              <s-box key={i} padding="small-200 base" background="subdued" borderRadius="large">
                <s-text type="strong">{t.content}</s-text>
              </s-box>
            ) : (
              <s-box key={i} padding="base" border="base" borderRadius="large">
                <s-stack direction="block" gap="small-200">
                  {t.data?.steps?.length ? (
                    <s-text color="subdued">
                      🔎 {t.data.steps.map((s) => s.label).join(" · ")}
                    </s-text>
                  ) : null}
                  <div
                    style={{ lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: renderReply(t.content) }}
                  />
                  {t.data?.parts?.map((p) => (
                    <s-link key={p.handle} href={p.url} target="_blank">
                      {p.title} — ${p.price} {p.available ? "· In stock" : "· Unavailable"}
                    </s-link>
                  ))}
                </s-stack>
              </s-box>
            ),
          )}

          <s-text-area
            label="Ask HVAC AI"
            rows={2}
            value={draft}
            placeholder="I'm working on a residential furnace and the gas valve will not come on."
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <s-stack direction="inline" gap="small-200">
            <s-button variant="primary" onClick={ask} loading={busy || undefined} disabled={!ready || undefined}>
              Ask
            </s-button>
            <s-button onClick={() => setTurns([])} disabled={busy || undefined}>
              Clear
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
