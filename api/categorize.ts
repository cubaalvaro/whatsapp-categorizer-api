import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { upload_id } = req.body as { upload_id?: string };
  if (!upload_id) return res.status(400).json({ error: "missing upload_id" });

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // TODO: fetch urls_filtered, call MCP categorize, write urls_processed
  // For now, return a stub response so we can validate plumbing:
  return res.json({ ok: true, upload_id, categories: [], coverage: 1, processed: 0 });
}