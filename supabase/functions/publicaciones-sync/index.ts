// ============================================================================
// publicaciones-sync — espejo de LECTURA de las publicaciones de Mercado Libre
// ----------------------------------------------------------------------------
// Trae todas las publicaciones del vendedor, las cruza con el costo real de
// Contabilium (productos.costo) y calcula, para cada una:
//   * precio_min  = piso rentable (cubre costo + comisión ML + margen mínimo)
//   * margen_pct  = margen neto al precio actual
//   * catalog     = si es de catálogo, si vamos ganando y el price_to_win
//   * sugerencia  = subir / bajar / mantener el precio (siempre cruzando con el
//                   costo: NUNCA se sugiere bajar por debajo del piso)
//   * alertas     = poco stock, sin stock, reponer, precio bajo el piso,
//                   perdiendo catálogo, reclamos, salud baja
// NUNCA escribe en Mercado Libre. Solo lee de ML y escribe la tabla local.
// Credenciales ML: canal_config (tipo='ml', con refresh_token).
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Parámetros de negocio (aproximados, revisables) ----------------------
// Comisión de ML por tipo de publicación (Argentina, orientativo por categoría).
const COMISION: Record<string, number> = { gold_pro: 0.28, gold_premium: 0.28, gold_special: 0.13, gold: 0.13, silver: 0.13, bronze: 0.13, free: 0 };
const COMISION_DEFAULT = 0.14;
const MARGEN_MIN = 0.10;      // margen neto mínimo aceptable (10%)
const STOCK_BAJO = 3;         // <= dispara alerta de poco stock

function comisionDe(listingType?: string): number {
  return listingType && listingType in COMISION ? COMISION[listingType] : COMISION_DEFAULT;
}
// Piso: precio de venta mínimo para cubrir costo + comisión ML + margen mínimo.
//   precio_min = costo / (1 - comision - margen_min)
function pisoRentable(costo: number, comision: number): number {
  const denom = 1 - comision - MARGEN_MIN;
  if (!(costo > 0) || denom <= 0) return 0;
  return Math.ceil(costo / denom);
}
// Margen neto al precio dado: (precio - comisión) - costo, sobre el precio.
function margenPct(precio: number, costo: number, comision: number): number {
  if (!(precio > 0)) return 0;
  const neto = precio * (1 - comision) - costo;
  return neto / precio;
}

async function getToken(d: DB): Promise<{ token: string; seller: string }> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").single();
  if (!cfg?.access_token) throw new Error("Mercado Libre no está conectado");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return { token: cfg.access_token, seller: String(cfg.seller_id) };
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, seller_id: String(j.user_id ?? cfg.seller_id), expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "ml");
  return { token: j.access_token, seller: String(j.user_id ?? cfg.seller_id) };
}
async function mlGet(path: string, token: string): Promise<any> {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`ML ${r.status} ${path}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}
async function mlTry(path: string, token: string): Promise<any | null> {
  try { return await mlGet(path, token); } catch { return null; }
}
function skuDe(it: Record<string, any>): string {
  if (it.seller_custom_field) return String(it.seller_custom_field);
  if (it.seller_sku) return String(it.seller_sku);
  const a = ((it.attributes ?? []) as Record<string, any>[]).find((x) => x.id === "SELLER_SKU");
  return a?.value_name ? String(a.value_name) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  try {
    const { token, seller } = await getToken(d);

    // Catálogo local: sku -> {producto_id, costo, disponible}
    const { data: prods } = await d.from("productos").select("id, sku, costo");
    const bySku = new Map<string, { id: string; costo: number }>();
    for (const p of prods ?? []) bySku.set(String(p.sku).toLowerCase(), { id: p.id, costo: Number(p.costo ?? 0) });

    // Disponible por producto (Contabilium) para la alerta "reponer".
    const { data: stk } = await d.from("stock").select("producto_id, cantidad, reservado, depositos!inner(codigo)");
    const dispPorProd = new Map<string, number>();
    for (const s of (stk ?? []) as any[]) {
      const cod = s.depositos?.codigo;
      if (cod === "GEN" || cod === "FLX") {
        const libre = Math.max(0, Number(s.cantidad ?? 0) - Number(s.reservado ?? 0));
        dispPorProd.set(s.producto_id, (dispPorProd.get(s.producto_id) ?? 0) + libre);
      }
    }

    // Reclamos/devoluciones por SKU (últimos 90 días) para alerta de reclamos.
    const desde90 = new Date(Date.now() - 90 * 86400_000).toISOString();
    const { data: devs } = await d.from("devoluciones").select("sku, created_at").gte("created_at", desde90);
    const reclamosPorSku = new Map<string, number>();
    for (const dv of (devs ?? []) as any[]) {
      const k = String(dv.sku ?? "").toLowerCase();
      if (k) reclamosPorSku.set(k, (reclamosPorSku.get(k) ?? 0) + 1);
    }

    // 1) scan de item ids del vendedor
    const ids: string[] = []; let scroll = "";
    for (let i = 0; i < 120; i++) {
      const data = await mlGet(`/users/${seller}/items/search?search_type=scan&limit=100` + (scroll ? `&scroll_id=${scroll}` : ""), token);
      const res = (data.results ?? []) as string[]; ids.push(...res);
      scroll = data.scroll_id ?? ""; if (!res.length || !scroll) break;
      await sleep(60);
    }

    const rows: Record<string, unknown>[] = [];
    const attrs = "id,title,price,currency_id,available_quantity,sold_quantity,health,status,permalink,thumbnail,category_id,listing_type_id,catalog_listing,catalog_product_id,seller_custom_field,seller_sku,attributes,shipping";

    for (let i = 0; i < ids.length; i += 20) {
      const arr = await mlGet(`/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=${attrs}`, token);
      for (const w of arr as Record<string, any>[]) {
        const it = w.body ?? w;
        if (!it || !it.id) continue;
        const sku = skuDe(it).toLowerCase();
        const prod = sku ? bySku.get(sku) : undefined;
        const costo = prod?.costo ?? 0;
        const listingType = String(it.listing_type_id ?? "");
        const comision = comisionDe(listingType);
        const precio = Number(it.price ?? 0);
        const precioMin = pisoRentable(costo, comision);
        const margen = costo > 0 ? margenPct(precio, costo, comision) : null;
        const isCatalog = Boolean(it.catalog_listing) || Boolean(it.catalog_product_id);
        const disp = prod ? (dispPorProd.get(prod.id) ?? 0) : 0;
        const avail = Number(it.available_quantity ?? 0);

        // Catálogo: price_to_win (best-effort). Devuelve el precio para ganar.
        let catalog: Record<string, unknown> = {};
        if (isCatalog && rows.length < 400) {
          const ptw = await mlTry(`/items/${it.id}/price_to_win?version=v2`, token);
          if (ptw) {
            const winner = ptw.winner ?? {};
            const ganando = ptw.status === "winning" || (winner.item_id && winner.item_id === it.id);
            catalog = {
              price_to_win: ptw.price_to_win ?? winner.price ?? null,
              precio_ganador: winner.price ?? null,
              ganando: Boolean(ganando),
              status: ptw.status ?? null,
              catalog_product_id: it.catalog_product_id ?? null,
            };
          }
          await sleep(70);
        }

        // ---- Sugerencia de precio (siempre cruzando con el piso) ----
        const sugerencia = calcularSugerencia({ precio, precioMin, costo, comision, isCatalog, catalog });

        // ---- Alertas ----
        const alertas: { tipo: string; nivel: string; texto: string }[] = [];
        if (avail === 0) alertas.push({ tipo: "sin_stock", nivel: "critico", texto: "Publicación sin stock" });
        else if (avail <= STOCK_BAJO) alertas.push({ tipo: "stock_bajo", nivel: "alerta", texto: `Poco stock publicado (${avail})` });
        if (avail <= STOCK_BAJO && disp > avail) alertas.push({ tipo: "reponer", nivel: "info", texto: `Hay ${disp} u. en Contabilium para reponer` });
        if (costo > 0 && precio > 0 && precio < precioMin) alertas.push({ tipo: "precio_bajo_piso", nivel: "critico", texto: `Precio por debajo del mínimo rentable ($${precioMin})` });
        if (isCatalog && catalog.ganando === false) alertas.push({ tipo: "catalogo_perdiendo", nivel: "alerta", texto: "Perdiendo el catálogo" });
        const rec = reclamosPorSku.get(sku) ?? 0;
        if (rec >= 2) alertas.push({ tipo: "reclamos", nivel: "alerta", texto: `${rec} devoluciones/reclamos en 90 días` });
        if (Number(it.health ?? 1) < 0.6) alertas.push({ tipo: "calidad", nivel: "info", texto: "Salud de la publicación baja" });

        rows.push({
          ml_item_id: String(it.id), sku: sku || null, producto_id: prod?.id ?? null,
          titulo: it.title ?? null, categoria_id: it.category_id ?? null,
          estado: it.status ?? null, precio, moneda: it.currency_id ?? "ARS",
          available_quantity: avail, sold_quantity: Number(it.sold_quantity ?? 0),
          health: it.health != null ? Number(it.health) : null,
          listing_type_id: listingType || null,
          logistic_type: it.shipping?.logistic_type ?? null,
          permalink: it.permalink ?? null, thumbnail: it.thumbnail ?? null,
          is_catalog: isCatalog, catalog_product_id: it.catalog_product_id ?? null,
          catalog, costo: costo || null, precio_min: precioMin || null,
          margen_pct: margen, sugerencia, alertas,
          atributos: (it.attributes ?? []).slice(0, 40),
          metrics: { sold_quantity: Number(it.sold_quantity ?? 0), health: it.health ?? null },
          raw: null, updated_at: new Date().toISOString(),
        });
      }
      await sleep(60);
    }

    // Upsert por lotes
    for (let i = 0; i < rows.length; i += 100) {
      await d.from("publicaciones").upsert(rows.slice(i, i + 100), { onConflict: "ml_item_id" });
    }
    await d.from("sync_estado").upsert({ job: "publicaciones", ultima_ok: new Date().toISOString(), detalle: { publicaciones: rows.length } }, { onConflict: "job" });

    const conAlerta = rows.filter((r) => (r.alertas as unknown[]).length > 0).length;
    return json({ ok: true, publicaciones: rows.length, con_alerta: conAlerta });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// Lógica de sugerencia de precio. Cruza SIEMPRE con el piso (costo + comisión +
// margen mínimo): nunca sugiere quedar por debajo del piso.
function calcularSugerencia(p: {
  precio: number; precioMin: number; costo: number; comision: number;
  isCatalog: boolean; catalog: Record<string, unknown>;
}): Record<string, unknown> {
  const { precio, precioMin, costo, comision, isCatalog, catalog } = p;
  const margenEn = (px: number) => costo > 0 ? Number((margenPct(px, costo, comision) * 100).toFixed(1)) : null;

  if (isCatalog && catalog.price_to_win != null) {
    const ptw = Number(catalog.price_to_win);
    const ganando = catalog.ganando === true;
    if (!ganando) {
      if (costo <= 0 || ptw >= precioMin) {
        // Se puede bajar para ganar sin perder el piso.
        return { accion: "bajar", precio_sugerido: ptw, motivo: "Bajar para ganar el catálogo, todavía por encima del piso rentable", margen_en_sugerido: margenEn(ptw) };
      }
      // Ganar exigiría bajar por debajo del costo mínimo: no conviene.
      return { accion: "mantener", motivo: "Para ganar habría que bajar por debajo del piso rentable — no conviene perseguir el catálogo", piso: precioMin };
    }
    // Ganando: si hay margen hacia arriba hasta el price_to_win, subir un poco.
    if (ptw > precio) {
      return { accion: "subir", precio_sugerido: ptw, motivo: "Ganás el catálogo con más margen (subir hasta el price_to_win)", margen_en_sugerido: margenEn(ptw) };
    }
    return { accion: "mantener", motivo: "Ganando el catálogo a buen precio" };
  }

  // No catálogo: decidir por margen.
  if (costo > 0 && precio < precioMin) {
    return { accion: "subir", precio_sugerido: precioMin, motivo: "Precio por debajo del piso rentable", margen_en_sugerido: margenEn(precioMin) };
  }
  return { accion: "mantener", motivo: costo > 0 ? "Precio con margen sobre el piso" : "Sin costo cargado en Contabilium para evaluar" };
}
