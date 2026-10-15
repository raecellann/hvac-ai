import Anthropic from "@anthropic-ai/sdk";
import {
  getPart,
  getPartsCollection,
  searchParts,
  type AdminGraphql,
  type PartDetail,
  type PartSummary,
} from "./parts.server";
import { buildSystemPrompt } from "./prompt.server";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AgentStep = { kind: "search" | "lookup"; label: string };

export type AgentReply = {
  reply: string;
  steps: AgentStep[];
  parts: PartSummary[];
};

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 1500;

let client: Anthropic | null = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_parts",
    description:
      "Search the store's HVAC Parts catalog. Returns only parts from the Parts collection with price and stock. Provide a part_number when known; otherwise short keywords like 'gas valve' or 'inducer motor'. Optionally filter by brand (e.g. 'Lennox', 'Carrier', 'Goodman').",
    input_schema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "Short part keywords" },
        part_number: { type: "string", description: "OEM part number / SKU" },
        brand: { type: "string", description: "Equipment or part brand" },
      },
    },
  },
  {
    name: "get_part",
    description:
      "Get full details (description, specs, variants, stock) for one part by its handle from search results or the page context.",
    input_schema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
    },
  },
];

/** Keep the conversation small, well-formed, and alternating. */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const msgs: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_HISTORY)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as ChatMessage).role;
    const content = String((m as ChatMessage).content ?? "")
      .slice(0, MAX_MESSAGE_CHARS)
      .trim();
    if ((role !== "user" && role !== "assistant") || !content) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else msgs.push({ role, content });
  }
  while (msgs[0]?.role === "assistant") msgs.shift();
  if (msgs[msgs.length - 1]?.role !== "user") return [];
  return msgs;
}

/** Split the trailing "PARTS: a, b" line off the model's answer. */
export function extractPartHandles(text: string) {
  const match = text.match(/\n?\s*PARTS:\s*([^\n]*)\s*$/i);
  if (!match) return { body: text.trim(), handles: [] as string[] };
  const handles = match[1]
    .split(",")
    .map((h) => h.trim())
    .filter((h) => /^[a-z0-9][a-z0-9-]*$/i.test(h))
    .slice(0, 3);
  return { body: text.slice(0, match.index).trim(), handles };
}

export async function runHvacAgent(args: {
  admin: AdminGraphql;
  shop: string;
  storeName?: string;
  messages: ChatMessage[];
  productHandle?: string | null;
  collectionTitle?: string | null;
}): Promise<AgentReply> {
  const { admin, shop } = args;
  const collectionId = await getPartsCollection(admin, shop);

  let viewingPart: PartDetail | null = null;
  if (args.productHandle) {
    viewingPart = await getPart(admin, shop, collectionId, args.productHandle);
  }

  const seen = new Map<string, PartSummary>();
  if (viewingPart) seen.set(viewingPart.handle, viewingPart);
  const steps: AgentStep[] = [];

  const system = buildSystemPrompt({
    storeName: args.storeName || "HVAC MORE",
    viewingPart,
    viewingCollection: args.collectionTitle,
  });

  const convo: Anthropic.MessageParam[] = args.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const anthropic = getClient();
  let finalText = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      system,
      tools: TOOLS,
      // On the last round force a text answer.
      tool_choice: round === MAX_TOOL_ROUNDS ? { type: "none" } : { type: "auto" },
      messages: convo,
    });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    finalText = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) break;

    convo.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      const input = (tu.input || {}) as Record<string, string>;
      try {
        if (tu.name === "search_parts") {
          const label = [input.brand, input.part_number || input.keywords]
            .filter(Boolean)
            .join(" ");
          steps.push({ kind: "search", label: `Searched parts: ${label}` });
          const parts = await searchParts(admin, shop, collectionId, input);
          parts.forEach((p) => seen.set(p.handle, p));
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(
              parts.length
                ? parts.map(({ image: _image, url: _url, ...rest }) => rest)
                : { results: [], note: "No matching parts in the Parts catalog." },
            ),
          });
        } else if (tu.name === "get_part") {
          const part = await getPart(admin, shop, collectionId, input.handle);
          if (part) {
            seen.set(part.handle, part);
            steps.push({ kind: "lookup", label: `Checked specs: ${part.title}` });
          }
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(
              part
                ? { ...part, image: undefined, url: undefined }
                : { error: "Not found in the Parts catalog." },
            ),
          });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Unknown tool",
            is_error: true,
          });
        }
      } catch (err) {
        console.error("HVAC AI tool error", tu.name, err);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Catalog lookup failed. Answer without it.",
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: results });
  }

  const { body, handles } = extractPartHandles(finalText);
  const parts = handles
    .map((h) => seen.get(h))
    .filter((p): p is PartSummary => Boolean(p))
    .map(({ handle, title, vendor, productType, sku, price, compareAtPrice, currency, available, url, image }) => ({
      handle, title, vendor, productType, sku, price, compareAtPrice, currency, available, url, image,
    }));

  return {
    reply: body || "I couldn't put together an answer for that. Can you describe the symptom or give me the part number?",
    steps,
    parts,
  };
}
