import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Cliente con SERVICE ROLE: bypassea RLS. Úsese SOLO dentro de Edge Functions,
// nunca se expone al navegador.
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error(
      "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno de la función",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Registro de auditoría best-effort (no rompe el flujo si falla).
export async function audit(
  db: SupabaseClient,
  entidad: string,
  entidad_id: string | null,
  accion: string,
  detalle: unknown,
  actor = "sistema",
): Promise<void> {
  try {
    await db.from("auditoria").insert({
      entidad,
      entidad_id,
      accion,
      detalle,
      actor,
    });
  } catch (_e) {
    // ignorar: la auditoría no debe frenar la operación
  }
}
