// ============================================================================
// ocr-ingreso — lee una foto/PDF de factura o remito y extrae los renglones
// ----------------------------------------------------------------------------
// Usa Claude (visión) para sacar { descripción, sku, cantidad, costo } de la
// imagen, y matchea cada renglón contra el catálogo (productos) y los alias que
// el sistema fue aprendiendo (sku_aliases). Devuelve las líneas con un nivel de
// confianza; las dudosas quedan para que la persona confirme en el panel.
//
// NO da de alta stock por sí sola: solo prepara el ingreso en borrador. El alta
// real se dispara al confirmar (función acciones → cola → worker).
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

interface LineaOCR {
  descripcion: string;
  sku?: string;
  cantidad: number;
  costo_unit?: number;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "usar POST" }, 405);

  const db = serviceClient();

  try {
    const body = await req.json();
    const {
      image_base64,
      media_type = "image/jpeg",
      proveedor = null,
      tipo = "local",
      deposito_destino_id = null,
    } = body ?? {};

    if (!image_base64) return json({ error: "falta image_base64" }, 400);
    if (!ANTHROPIC_KEY) return json({ error: "falta ANTHROPIC_API_KEY" }, 500);

    // 1) Extraer renglones con Claude
    const lineas = await extraerLineas(image_base64, media_type);

    // 2) Crear el ingreso en borrador
    const { data: ingreso, error: eIng } = await db
      .from("ingresos")
      .insert({
        tipo,
        proveedor,
        deposito_destino_id,
        estado: "borrador",
        ocr_json: { lineas },
      })
      .select()
      .single();
    if (eIng) throw eIng;

    // 3) Matchear cada renglón y guardar los items
    const items = [];
    for (const l of lineas) {
      const m = await matchProducto(db, l);
      items.push({
        ingreso_id: ingreso.id,
        sku_detectado: l.sku ?? null,
        descripcion: l.descripcion,
        producto_id: m.producto_id,
        cantidad: Math.max(1, Math.round(l.cantidad || 1)),
        costo_unit: l.costo_unit ?? null,
        confianza: m.confianza,
        confirmado: m.confianza >= 0.95, // alto match = pre-confirmado
      });
    }
    const { data: saved, error: eItems } = await db
      .from("ingreso_items")
      .insert(items)
      .select("*, producto:productos(sku, nombre)");
    if (eItems) throw eItems;

    return json({ ok: true, ingreso_id: ingreso.id, items: saved });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---- Claude visión --------------------------------------------------------
async function extraerLineas(imageB64: string, mediaType: string): Promise<LineaOCR[]> {
  const prompt =
    `Sos un asistente que lee facturas y remitos de proveedores (Argentina). ` +
    `Extraé SOLO los renglones de productos de esta imagen. ` +
    `Devolvé un JSON válido y nada más, con esta forma:\n` +
    `{"lineas":[{"descripcion":"texto tal cual","sku":"código si aparece","cantidad":número,"costo_unit":número}]}\n` +
    `Reglas: "cantidad" es entero (unidades). "costo_unit" es el precio unitario sin impuestos si se distingue, si no el que haya. ` +
    `Omití subtotales, IVA, totales y datos que no sean productos. Si un campo no está, omitilo.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageB64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonStr);
  return (parsed.lineas ?? []) as LineaOCR[];
}

// ---- Matching contra catálogo + alias ------------------------------------
async function matchProducto(
  db: ReturnType<typeof serviceClient>,
  l: LineaOCR,
): Promise<{ producto_id: string | null; confianza: number }> {
  // 1) SKU exacto
  if (l.sku) {
    const { data } = await db.from("productos").select("id").ilike("sku", l.sku).limit(1);
    if (data && data.length) return { producto_id: data[0].id, confianza: 0.99 };
  }
  // 2) Alias aprendido
  const texto = (l.sku || l.descripcion || "").trim();
  if (texto) {
    const { data } = await db
      .from("sku_aliases").select("producto_id").ilike("alias", texto).limit(1);
    if (data && data.length) return { producto_id: data[0].producto_id, confianza: 0.9 };
  }
  // 3) Coincidencia por nombre (parcial)
  if (l.descripcion) {
    const palabra = l.descripcion.split(/\s+/).filter((w) => w.length >= 4)[0];
    if (palabra) {
      const { data } = await db
        .from("productos").select("id").ilike("nombre", `%${palabra}%`).limit(1);
      if (data && data.length) return { producto_id: data[0].id, confianza: 0.6 };
    }
  }
  return { producto_id: null, confianza: 0 };
}
