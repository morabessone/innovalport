import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Publicacion, PublicacionSugerencia, Alerta } from "../lib/types.ts";

export type PubTab = "activas" | "pendientes" | "optim";

const money = (n?: number | null, moneda = "ARS") =>
  n == null ? "—" : new Intl.NumberFormat("es-AR", { style: "currency", currency: moneda, maximumFractionDigits: 0 }).format(n);
const pct = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);

// El nivel más grave de las alertas define el borde de la tarjeta.
function peor(alertas: Alerta[]): "critico" | "alerta" | "info" | "" {
  if (alertas.some((a) => a.nivel === "critico")) return "critico";
  if (alertas.some((a) => a.nivel === "alerta")) return "alerta";
  if (alertas.some((a) => a.nivel === "info")) return "info";
  return "";
}
const ALERTA_LABEL: Record<string, string> = {
  sin_stock: "Sin stock", stock_bajo: "Poco stock", reponer: "Reponer",
  precio_bajo_piso: "Precio bajo el piso", catalogo_perdiendo: "Perdiendo catálogo",
  reclamos: "Reclamos", calidad: "Salud baja",
};

export function Publicaciones({ subtab, notify }: { subtab: PubTab; notify: (m: string) => void }) {
  const [pubs, setPubs] = useState<Publicacion[]>([]);
  const [sugs, setSugs] = useState<PublicacionSugerencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [detalle, setDetalle] = useState<Publicacion | null>(null);
  const [q, setQ] = useState("");
  const [soloAlertas, setSoloAlertas] = useState(false);
  const [soloCatalogo, setSoloCatalogo] = useState(false);
  const [verViejas, setVerViejas] = useState(false);

  async function cargar() {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([api.publicaciones(), api.sugerenciasPub()]);
      setPubs(p); setSugs(s);
    } catch (e) { notify("Error al cargar: " + (e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { cargar(); }, []);

  async function sync() {
    setBusy(true);
    try { await api.syncPublicaciones(); await cargar(); notify("Publicaciones actualizadas desde Mercado Libre"); }
    catch (e) { notify("Error: " + (e as Error).message); }
    finally { setBusy(false); }
  }
  async function generar() {
    setBusy(true);
    try { await api.sugerirPublicacion(); await cargar(); notify("Borradores generados"); }
    catch (e) { notify("Error: " + (e as Error).message); }
    finally { setBusy(false); }
  }

  // Base: solo las "activas de verdad" (con stock o ventas en 90 días), salvo
  // que se pida ver las viejas/inactivas.
  const activas = useMemo(() => pubs.filter((p) => p.activa_real), [pubs]);
  const viejas = pubs.length - activas.length;

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    const base = verViejas ? pubs : activas;
    return base.filter((p) => {
      if (soloAlertas && p.alertas.length === 0) return false;
      if (soloCatalogo && !p.is_catalog) return false;
      if (t && !(`${p.titulo ?? ""} ${p.sku ?? ""} ${p.ml_item_id}`.toLowerCase().includes(t))) return false;
      return true;
    });
  }, [pubs, activas, verViejas, q, soloAlertas, soloCatalogo]);

  // Optimizaciones: SOLO sobre publicaciones activas de verdad, con sugerencia
  // accionable o alertas, ordenadas por impacto.
  const optimizaciones = useMemo(() => {
    const rank = (p: Publicacion) => {
      const n = peor(p.alertas);
      const base = n === "critico" ? 3 : n === "alerta" ? 2 : n === "info" ? 1 : 0;
      const acc = p.sugerencia?.accion && p.sugerencia.accion !== "mantener" ? 1 : 0;
      return base * 2 + acc;
    };
    return activas
      .filter((p) => (p.sugerencia?.accion && p.sugerencia.accion !== "mantener") || p.alertas.length > 0)
      .sort((a, b) => rank(b) - rank(a));
  }, [activas]);

  if (loading) return <div className="stack"><PubHead subtab={subtab} /><div className="empty">Cargando…</div></div>;

  return (
    <div className="stack">
      <PubHead subtab={subtab}
        right={subtab === "pendientes"
          ? <button className="btn" onClick={generar} disabled={busy}>{busy ? "Generando…" : "✦ Generar borradores"}</button>
          : <button className="btn" onClick={sync} disabled={busy}>{busy ? "Actualizando…" : "↻ Actualizar desde ML"}</button>}
      />

      {subtab === "activas" && (
        <>
          <div className="kpis">
            <Kpi n={activas.length} label="Activas (con stock o venta 90d)" />
            <Kpi n={activas.filter((p) => p.is_catalog && p.catalog?.ganando === false).length} label="Perdiendo catálogo" tone="warn" />
            <Kpi n={activas.filter((p) => p.alertas.some((a) => a.tipo === "precio_bajo_piso")).length} label="Bajo el piso" tone="crit" />
            <Kpi n={activas.filter((p) => p.alertas.some((a) => a.tipo === "reponer")).length} label="Para reponer" tone="info" />
          </div>
          <div className="filters">
            <input className="input grow" placeholder="Buscar por título, SKU o MLA…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="chk"><input type="checkbox" checked={soloAlertas} onChange={(e) => setSoloAlertas(e.target.checked)} /> Solo con alertas</label>
            <label className="chk"><input type="checkbox" checked={soloCatalogo} onChange={(e) => setSoloCatalogo(e.target.checked)} /> Solo catálogo</label>
            {viejas > 0 && <label className="chk"><input type="checkbox" checked={verViejas} onChange={(e) => setVerViejas(e.target.checked)} /> Ver {viejas} viejas/inactivas</label>}
          </div>
          <div className="pub-grid">
            {filtradas.map((p) => <PubCard key={p.ml_item_id} p={p} onOpen={() => setDetalle(p)} />)}
            {filtradas.length === 0 && <div className="empty">No hay publicaciones con esos filtros.</div>}
          </div>
        </>
      )}

      {subtab === "pendientes" && (
        <>
          <p className="muted" style={{ maxWidth: "70ch" }}>
            Productos que ya están en Contabilium pero <b>todavía no tienen publicación</b>. Cada tarjeta es un
            <b> borrador optimizado</b> (título y descripción pensados para posicionar) con imágenes de referencia.
            Nada se publica solo: el botón de publicar exige confirmación manual y por ahora está deshabilitado.
          </p>
          <div className="pub-grid">
            {sugs.map((s) => <SugCard key={s.id} s={s} />)}
            {sugs.length === 0 && <div className="empty">No hay borradores todavía. Tocá “Generar borradores”.</div>}
          </div>
        </>
      )}

      {subtab === "optim" && (
        <>
          <p className="muted" style={{ maxWidth: "70ch" }}>
            Oportunidades de mejora detectadas, ordenadas por impacto. Cada acción es una <b>sugerencia</b>:
            aplicarla en Mercado Libre requiere confirmación manual (deshabilitado por ahora).
          </p>
          <div className="opt-list">
            {optimizaciones.map((p) => <OptRow key={p.ml_item_id} p={p} onOpen={() => setDetalle(p)} />)}
            {optimizaciones.length === 0 && <div className="empty">Sin optimizaciones pendientes. 🎉</div>}
          </div>
        </>
      )}

      {detalle && <Detalle p={detalle} onClose={() => setDetalle(null)} />}
    </div>
  );
}

function PubHead({ subtab, right }: { subtab: PubTab; right?: React.ReactNode }) {
  const titulos: Record<PubTab, [string, string]> = {
    activas: ["Publicaciones activas", "Todas las publicaciones de Mercado Libre, con métricas y alertas"],
    pendientes: ["Pendientes de publicar", "Productos de Contabilium sin publicación, con borrador sugerido"],
    optim: ["Optimizaciones", "Mejoras sugeridas sobre las publicaciones activas"],
  };
  const [t, sub] = titulos[subtab];
  return (
    <div className="section-head">
      <div><span className="eyebrow">Publicaciones</span><h2>{t}</h2><p className="muted">{sub}</p></div>
      {right}
    </div>
  );
}

function Kpi({ n, label, tone }: { n: number; label: string; tone?: "warn" | "crit" | "info" }) {
  return (
    <div className="card card-pad kpi">
      <div className={"kpi-n " + (tone ?? "")}>{n}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

function AlertChips({ alertas }: { alertas: Alerta[] }) {
  return (
    <div className="alert-chips">
      {alertas.map((a, i) => <span key={i} className={"achip " + a.nivel} title={a.texto}>{ALERTA_LABEL[a.tipo] ?? a.tipo}</span>)}
    </div>
  );
}

function PubCard({ p, onOpen }: { p: Publicacion; onOpen: () => void }) {
  const borde = peor(p.alertas);
  const acc = p.sugerencia?.accion;
  return (
    <button className={"pub-card border-" + borde} onClick={onOpen}>
      <div className="pub-thumb">
        {p.thumbnail ? <img src={p.thumbnail.replace("http://", "https://")} alt="" loading="lazy" /> : <span className="pub-noimg">📦</span>}
        {p.is_catalog && <span className={"cat-badge " + (p.catalog?.ganando ? "win" : "lose")}>{p.catalog?.ganando ? "Catálogo ✓" : "Catálogo ✗"}</span>}
      </div>
      <div className="pub-body">
        <div className="pub-title">{p.titulo ?? p.ml_item_id}</div>
        <div className="pub-price">{money(p.precio, p.moneda)}
          {acc && acc !== "mantener" && <span className={"acc-tag " + acc}>{acc === "bajar" ? "▼ bajar" : "▲ subir"}</span>}
        </div>
        <div className="pub-meta">
          <span>{p.sold_quantity} vendidos</span>
          <span>· stock {p.available_quantity}</span>
          {p.margen_pct != null && <span>· margen {pct(p.margen_pct)}</span>}
        </div>
        {p.alertas.length > 0 && <AlertChips alertas={p.alertas} />}
      </div>
    </button>
  );
}

function SugCard({ s }: { s: PublicacionSugerencia }) {
  return (
    <div className="pub-card sug-card">
      <div className="sug-imgs">
        {s.imagenes.slice(0, 4).map((u, i) => <img key={i} src={u} alt="" loading="lazy" />)}
        {s.imagenes.length === 0 && <span className="pub-noimg">🖼️ sin imágenes</span>}
      </div>
      <div className="pub-body">
        <div className="sug-tag">Borrador · sin publicar</div>
        <div className="pub-title">{s.titulo_sugerido}</div>
        {s.categoria_sugerida && <div className="muted" style={{ fontSize: ".8rem" }}>Categoría: {s.categoria_sugerida}</div>}
        <p className="sug-desc">{s.descripcion_sugerida}</p>
        {s.atributos?.length > 0 && (
          <div className="sug-attrs">
            {s.atributos.slice(0, 6).map((a, i) => <span key={i} className="attr-chip">{a.nombre}: <b>{a.valor}</b></span>)}
          </div>
        )}
        {s.fuente_imagenes && <div className="faint" style={{ fontSize: ".72rem" }}>Imágenes de referencia ({s.fuente_imagenes}) — reemplazar por fotos reales antes de publicar.</div>}
        <div className="sug-actions">
          <button className="btn primary" disabled title="Escritura deshabilitada — requiere confirmación manual">Publicar en ML</button>
          <span className="faint" style={{ fontSize: ".74rem" }}>🔒 publicación manual (deshabilitada)</span>
        </div>
      </div>
    </div>
  );
}

function OptRow({ p, onOpen }: { p: Publicacion; onOpen: () => void }) {
  const s = p.sugerencia ?? {};
  const borde = peor(p.alertas);
  return (
    <button className={"opt-row border-" + borde} onClick={onOpen}>
      <div className="opt-main">
        <div className="opt-title">{p.titulo ?? p.ml_item_id}</div>
        <div className="opt-sub">
          {s.accion && s.accion !== "mantener"
            ? <>Precio {money(p.precio, p.moneda)} → <b>{money(s.precio_sugerido, p.moneda)}</b> · {s.motivo}</>
            : (p.alertas[0]?.texto ?? "Revisar")}
        </div>
      </div>
      {p.alertas.length > 0 && <AlertChips alertas={p.alertas} />}
      <span className="opt-open">Ver →</span>
    </button>
  );
}

function Detalle({ p, onClose }: { p: Publicacion; onClose: () => void }) {
  const s = p.sugerencia ?? {};
  const cat = p.catalog ?? {};
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal pub-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{p.titulo ?? p.ml_item_id}</h3>
          <button className="btn ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="pub-modal-grid">
          <div className="pm-media">
            {p.thumbnail ? <img src={p.thumbnail.replace("http://", "https://")} alt="" /> : <div className="pub-noimg big">📦</div>}
            {p.permalink && <a className="btn btn-sm" href={p.permalink} target="_blank" rel="noreferrer">Ver en ML ↗</a>}
            <div className="faint" style={{ fontSize: ".74rem" }}>MLA: {p.ml_item_id} · SKU: {p.sku ?? "—"}</div>
          </div>

          <div className="pm-fields">
            {/* Campos editables (visual; guardar deshabilitado) */}
            <div className="row2">
              <Field label="Título"><input className="input" defaultValue={p.titulo ?? ""} /></Field>
              <Field label="Precio"><input className="input" type="number" defaultValue={p.precio} /></Field>
            </div>
            <div className="row2">
              <Field label="Stock publicado"><input className="input" type="number" defaultValue={p.available_quantity} /></Field>
              <Field label="Estado"><input className="input" defaultValue={p.estado ?? ""} readOnly /></Field>
            </div>

            {/* Rentabilidad, cruzando con Contabilium */}
            <div className="pm-box">
              <div className="pm-box-t">Rentabilidad (cruzado con Contabilium)</div>
              <div className="pm-stats">
                <Stat k="Costo (Contab.)" v={money(p.costo, p.moneda)} />
                <Stat k="Piso rentable" v={money(p.precio_min, p.moneda)} hint="Mínimo para cubrir costo + comisión + margen" />
                <Stat k="Precio actual" v={money(p.precio, p.moneda)} />
                <Stat k="Margen actual" v={pct(p.margen_pct)} tone={p.margen_pct != null && p.margen_pct < 0.1 ? "crit" : "ok"} />
              </div>
            </div>

            {/* Catálogo */}
            {p.is_catalog && (
              <div className="pm-box">
                <div className="pm-box-t">Catálogo {cat.ganando ? <span className="achip ok">Ganando</span> : <span className="achip alerta">Perdiendo</span>}</div>
                <div className="pm-stats">
                  <Stat k="Precio del ganador" v={money(cat.precio_ganador, p.moneda)} />
                  <Stat k="Precio para ganar" v={money(cat.price_to_win, p.moneda)} />
                </div>
              </div>
            )}

            {/* Sugerencia de precio */}
            <div className={"pm-suggest acc-" + (s.accion ?? "mantener")}>
              <div className="pm-suggest-h">
                {s.accion === "bajar" ? "▼ Conviene bajar el precio" : s.accion === "subir" ? "▲ Hay margen para subir" : "✓ Mantener el precio"}
              </div>
              <p>{s.motivo}</p>
              {s.precio_sugerido != null && (
                <div className="pm-suggest-px">
                  Sugerido: <b>{money(s.precio_sugerido, p.moneda)}</b>
                  {s.margen_en_sugerido != null && <span className="faint"> · margen resultante {s.margen_en_sugerido}%</span>}
                </div>
              )}
              <button className="btn primary" disabled title="Escritura deshabilitada — requiere confirmación manual" style={{ marginTop: 10 }}>
                Aplicar en ML
              </button>
              <span className="faint" style={{ fontSize: ".74rem", marginLeft: 10 }}>🔒 requiere confirmación manual (deshabilitado)</span>
            </div>

            {p.alertas.length > 0 && (
              <div className="pm-box">
                <div className="pm-box-t">Alertas</div>
                <ul className="pm-alertas">
                  {p.alertas.map((a, i) => <li key={i} className={a.nivel}>{a.texto}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field" style={{ marginBottom: 0 }}><label>{label}</label>{children}</div>;
}
function Stat({ k, v, hint, tone }: { k: string; v: string; hint?: string; tone?: "ok" | "crit" }) {
  return (
    <div className="pm-stat" title={hint}>
      <div className="pm-stat-k">{k}</div>
      <div className={"pm-stat-v " + (tone ?? "")}>{v}</div>
    </div>
  );
}
