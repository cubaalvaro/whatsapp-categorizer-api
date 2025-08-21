import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const WS_TIMEOUT_MS = 30_000; // prevent hanging requests
const MAX_ITEMS = 500;        // cap payload size to MCP

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    const { upload_id } = req.body as { upload_id?: string };
    if (!upload_id) return res.status(400).json({ error: "missing upload_id" });

    // ---- Env checks
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const MCP_WS_URL = process.env.MCP_WS_URL;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "server_misconfig: missing Supabase envs" });
    }
    if (!MCP_WS_URL) {
      return res.status(500).json({ error: "server_misconfig: missing MCP_WS_URL" });
    }

    // ---- DB fetch
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: filtered, error } = await supabase
      .from("urls_filtered")
      .select("id, raw_text, url, matched_keywords")
      .eq("upload_id", upload_id);

    if (error) return res.status(400).json({ error: error.message });

    const list = filtered ?? [];
    if (list.length === 0) {
      // Nothing to categorize; short-circuit
      return res.json({ ok: true, upload_id, processed: 0, coverage: 1, categories: [] });
    }

    // ---- Shape items for MCP (cap size)
    const items = list.slice(0, MAX_ITEMS).map((r: any, i: number) => ({
      i,
      text: r.raw_text,
      url: r.url,
      keywords: r.matched_keywords,
    }));

    // ---- Call MCP over WebSocket with timeout
    const { assignments, categories, coverage } = await callMCP(MCP_WS_URL, "categorize_whatsapp", items);

    // ---- Persist results
    const rows = list.map((r: any, i: number) => ({
      filtered_id: r.id,
      category: assignments?.[i] || "Other",
      confidence: 0.9,
    }));

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("urls_processed").insert(rows);
      if (insErr) return res.status(400).json({ error: insErr.message });
    }

    return res.json({
      ok: true,
      upload_id,
      processed: rows.length,
      coverage: typeof coverage === "number" ? coverage : null,
      categories: Array.isArray(categories) ? categories : [],
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "server_error" });
  }
}

// borrar luego
if (!/^wss?:\/\//.test(process.env.MCP_WS_URL || "")) {
  return res.status(500).json({ error: "bad_mcp_ws_url", got: process.env.MCP_WS_URL || null });
}

function callMCP(
  wsUrl: string,
  tool: string,
  items: Array<{ i: number; text: string; url?: string; keywords?: string[] }>
): Promise<{ assignments: string[]; categories: any[]; coverage: number }> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("mcp_timeout"));
    }, WS_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, tool, items }));
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(String(buf));
        if (msg.id !== id) return; // ignore other messages
        clearTimeout(timer);
        settled = true;
        if (msg.ok) {
          // Normalize outputs
          const assignments = Array.isArray(msg.assignments) ? msg.assignments : [];
          const categories = Array.isArray(msg.categories) ? msg.categories : [];
          const coverage = typeof msg.coverage === "number" ? msg.coverage : 1;
          resolve({ assignments, categories, coverage });
        } else {
          reject(new Error(msg.error || "mcp_tool_error"));
        }
        ws.close();
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(err);
    });

    ws.on("close", () => {
      // If server closed before sending our response
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("mcp_closed"));
      }
    });
  });
}
