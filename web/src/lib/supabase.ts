import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Proyecto Supabase del Centro de Stock. La anon key es pública por diseño
// (el acceso real lo controla RLS: lectura de datos operativos y escritura solo
// vía Edge Functions). Se dejan como valores por defecto para que el deploy
// quede conectado sin configurar variables; se pueden sobreescribir con
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en el entorno.
const DEFAULT_URL = "https://tqgkkzbmupxsqufxjrjb.supabase.co";
const DEFAULT_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxZ2tremJtdXB4c3F1ZnhqcmpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MjkxODgsImV4cCI6MjA5OTAwNTE4OH0.dHXXy55YB2q0X-TPwTygo252vgeBGLuX54tpBiQs9Bw";

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_URL;
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || DEFAULT_ANON;

export const isConnected = Boolean(url && anon);

export const supabase: SupabaseClient | null = isConnected
  ? createClient(url, anon)
  : null;

export const functionsBase = isConnected ? `${url}/functions/v1` : "";
export const anonKey = anon ?? "";
