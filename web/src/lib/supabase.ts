import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConnected = Boolean(url && anon);

export const supabase: SupabaseClient | null = isConnected
  ? createClient(url!, anon!)
  : null;

export const functionsBase = isConnected ? `${url}/functions/v1` : "";
export const anonKey = anon ?? "";
