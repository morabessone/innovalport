import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";
import { ProductoDetalle } from "./ProductoDetalle.tsx";

// Depósitos de venta que hay que mantener con stock, y de dónde se repone.
// Full: lo abastece Mercado Libre con colectas desde Genpol (manual) → solo aviso.
// Flexit: pool de ML Flex + Tienda Nube; se repone desde Genpol / Oficina.
const OBJETIVOS = [
  { code: "FULL", nombre: "Full", detalle: "Colecta manual desde Genpol (la retira ML)" },
  { code: "FLX", nombre: "Flexit", detalle: "Reponer desde Genpol u Oficina" },
];
const FUENTES = ["GEN", "OFI"];

interface Aviso {
  p: StockConsolidado;
  objetivo: string; nombreObj: string; detalle: string;
  actual: number; min: number; faltan: number;
  fuente: string; disponible: number;
}

export function Reponer({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<StockConsolidado | null>(null);

  async function load() {
    setLoading(true);
    const s = await api.stock();
    setStock(s); setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const avisos = useMemo<Aviso[]>(() => {
    const out: Aviso[] = [];
    for (const p of stock) {
      if (!p.activo || p.tipo !== "P" || p.stock_minimo <= 0) continue;
      for (const o of OBJETIVOS) {
        const actual = p.por_deposito[o.code] ?? 0;
        if (actual >= p.stock_minimo) continue;
        let mejor = ""; let disp = 0;
        for (const f of FUENTES) {
          const d = p.por_deposito[f] ?? 0;
          if (d > disp) { disp = d; mejor = f; }
        }
        out.push({
          p, objetivo: o.code, nombreObj: o.nombre, detalle: o.detalle,
          actual, min: p.stock_minimo, faltan: Math.max(0, p.stock_minimo - actual),
          fuente: mejor || "GEN", disponible: disp,
        });
      }
    }
    return out.sort((a, b) => (a.actual / a.min) - (b.actual / b.min));
  }, [stock]);

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? avisos.filter((a) => `${a.p.sku} ${a.p.nombre}`.toLowerCase().includes(t)) : avisos;
  }, [avisos, q]);

  const nFull = avisos.filter((a) => a.objetivo === "FULL").length;
  const nFlex = avisos.filter((a) => a.objetivo === "FLX").length;

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Reponer</span><h2>Reposición sugerida</h2></div>
        <span className="muted">{avisos.length} aviso(s)</span>
      </div>

      <div className="tiles">
        <div className={"tile" + (nFull ? " alert" : "")}><b className="tnum">{nFull}</b><span>Reponer en Full</span></div>
        <div className={"tile" + (nFlex ? " warnv" : "")}><b className="tnum">{nFlex}</b><span>Reponer en Flexit</span></div>
      </div>

      <div className="pill-note">
        Productos por debajo de su <b>mínimo</b> (se setea en el detalle de cada producto). En <b>Full</b>, programá una
        colecta desde Genpol; en <b>Flexit</b>, reponé desde Genpol u Oficina. Los movimientos y remitos se registran en Contabilium.
      </div>

      <input className="input" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />

      {loading && <div className="empty">Cargando…</div>}
      {!loading && filtradas.length === 0 && (
        <div className="card"><div className="empty">✓ No hay reposiciones pendientes. Full y Flexit por encima del mínimo.</div></div>
      )}

      <div className="repo-grid">
        {filtradas.map((a) => {
          const key = a.p.producto_id + a.objetivo;
          const critico = a.actual <= 0;
          return (
            <div className="card repo-card rowlink" key={key} onClick={() => setSel(a.p)}>
              <div className="between">
                <div className="sku mono">{a.p.sku}<small style={{ fontFamily: "var(--sans)" }}>{a.p.nombre}</small></div>
                <span className={"badge " + (critico ? "sin_stock" : "reponer")}>{a.nombreObj}</span>
              </div>
              <div className="repo-nums">
                <span>En {a.nombreObj}: <b className={critico ? "danger" : ""}>{a.actual}</b></span>
                <span>Mínimo: <b>{a.min}</b></span>
                <span>Faltan: <b>{a.faltan}</b></span>
              </div>
              <div className="repo-nums">
                <span style={{ fontSize: ".8rem" }}>{a.detalle}. Disponible en {a.fuente}: <b>{a.disponible}</b>{a.disponible < a.faltan ? " ⚠ no alcanza" : ""}</span>
              </div>
            </div>
          );
        })}
      </div>

      {sel && (
        <ProductoDetalle producto={sel} onClose={() => setSel(null)} onSaved={async () => { await load(); }} notify={notify} />
      )}
    </div>
  );
}
