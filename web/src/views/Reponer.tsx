import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, StockConsolidado } from "../lib/types.ts";

// Depósitos "de venta" que hay que mantener con stock, y de dónde reponer.
const CANALES = [
  { code: "FULL", nombre: "Mercado Libre Full" },
  { code: "FLX", nombre: "Flexit (envíos Flex)" },
];
const FUENTES = ["OFI", "GEN"]; // de dónde sale el stock a reponer

interface Sugerencia {
  producto_id: string; sku: string; nombre: string;
  canal: string; actual: number; min: number;
  fuente: string; disponible: number; sugerido: number;
}

export function Reponer({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [q, setQ] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [fuente, setFuente] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [s, d] = await Promise.all([api.stock(), api.depositos()]);
    setStock(s); setDeps(d); setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const depId = (code: string) => deps.find((d) => d.codigo === code)?.id ?? "";

  const sugerencias = useMemo<Sugerencia[]>(() => {
    const out: Sugerencia[] = [];
    for (const p of stock) {
      if (!p.activo || p.stock_minimo <= 0) continue;
      for (const c of CANALES) {
        const actual = p.por_deposito[c.code] ?? 0;
        if (actual >= p.stock_minimo) continue;
        // fuente: la que tenga más stock disponible
        let mejor = ""; let disp = 0;
        for (const f of FUENTES) {
          const d = p.por_deposito[f] ?? 0;
          if (d > disp) { disp = d; mejor = f; }
        }
        if (disp <= 0) continue;
        const target = p.stock_minimo * 2;
        out.push({
          producto_id: p.producto_id, sku: p.sku, nombre: p.nombre, canal: c.code,
          actual, min: p.stock_minimo, fuente: mejor, disponible: disp,
          sugerido: Math.min(disp, target - actual),
        });
      }
    }
    // más críticos primero (menor cobertura)
    return out.sort((a, b) => a.actual / a.min - b.actual / b.min);
  }, [stock]);

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? sugerencias.filter((s) => `${s.sku} ${s.nombre}`.toLowerCase().includes(t)) : sugerencias;
  }, [sugerencias, q]);

  async function reponer(s: Sugerencia) {
    const key = s.producto_id + s.canal;
    const cantidad = qty[key] ?? s.sugerido;
    const f = fuente[key] ?? s.fuente;
    if (cantidad <= 0) return notify("Cantidad inválida");
    setWorking(key);
    try {
      await api.moverStock(depId(f), depId(s.canal), [{ producto_id: s.producto_id, cantidad }]);
      await load();
      notify(`${cantidad} u. de ${s.sku} → ${s.canal}`);
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Reponer</span><h2>Reposición sugerida</h2></div>
        <span className="muted">{sugerencias.length} sugerencia(s)</span>
      </div>

      <div className="pill-note">
        Productos por debajo del mínimo en <b>Full</b> o <b>Flex</b>. Tocá <b>Reponer</b> y el
        movimiento (con su remito) se hace solo desde donde haya stock.
      </div>

      <input className="input" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />

      {loading && <div className="empty">Cargando…</div>}
      {!loading && filtradas.length === 0 && (
        <div className="card"><div className="empty">✓ No hay reposiciones pendientes. Full y Flex con stock suficiente.</div></div>
      )}

      <div className="repo-grid">
        {filtradas.map((s) => {
          const key = s.producto_id + s.canal;
          return (
            <div className="card repo-card" key={key}>
              <div className="between">
                <div className="sku mono">{s.sku}<small style={{ fontFamily: "var(--sans)" }}>{s.nombre}</small></div>
                <span className={"badge " + (s.actual === 0 ? "sin_stock" : "reponer")}>{s.canal}</span>
              </div>
              <div className="repo-nums">
                <span>En {s.canal}: <b className={s.actual === 0 ? "danger" : ""}>{s.actual}</b></span>
                <span>Mínimo: <b>{s.min}</b></span>
                <span>Disp. en {s.fuente}: <b>{s.disponible}</b></span>
              </div>
              <div className="repo-actions">
                <select className="select" value={fuente[key] ?? s.fuente} onChange={(e) => setFuente((f) => ({ ...f, [key]: e.target.value }))} style={{ width: 90 }}>
                  {FUENTES.filter((f) => (stock.find((x) => x.producto_id === s.producto_id)?.por_deposito[f] ?? 0) > 0).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <input className="input qtybox" type="number" min={1} max={s.disponible}
                  value={qty[key] ?? s.sugerido}
                  onChange={(e) => setQty((x) => ({ ...x, [key]: Math.max(1, Math.min(s.disponible, Number(e.target.value) || 0)) }))} />
                <button className="btn primary btn-sm grow" disabled={working === key} onClick={() => reponer(s)}>
                  {working === key ? "…" : "Reponer →"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
