// Autenticación con Google (Supabase Auth). Solo se permite el ingreso a cuentas
// del dominio de Innovalport. La restricción se aplica en dos capas:
//   1. `hd` le pide a Google que muestre solo cuentas @innovalport.com.
//   2. Al volver, se verifica el dominio del email y, si no corresponde, se
//      cierra la sesión (no alcanza con el hint de Google, hay que validar).
import { supabase } from "./supabase.ts";

export const ALLOWED_DOMAIN = "innovalport.com";

export function emailAllowed(email?: string | null): boolean {
  return !!email && email.trim().toLowerCase().endsWith("@" + ALLOWED_DOMAIN);
}

export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado en este entorno.");
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
      queryParams: { hd: ALLOWED_DOMAIN, prompt: "select_account" },
    },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}
