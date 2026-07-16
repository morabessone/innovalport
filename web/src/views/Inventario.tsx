import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, StockConsolidado } from "../lib/types.ts";

export function Inventario({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [dep, setDep] = useState("GEN");
  const [q, setQ] = useState("");
  const [conteo, setConteo] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [soloConStock, setSoloConStock] = useState(true);

  async function load() {
    const [d, s] = await Promise.all([api.depositos(), api.stock()]);
    setDeps(d); setStock(s);
  }
  useEffect(() => { load(); }, []);

  const depId = (code: string) => deps.find((x) => x.codigo === code)?.id ?? "";

  const filas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return stock.filter((s) => {
      if (!s.activo || s.tipo !== "P") return false;
      const sis = s.por_deposito[dep] ?? 0;
      if (soloConStock && sis <= 0) return false;
      if (t && !`${s.sku} ${s.nombre}`.toLowerCase().includes(t)) return false;
      return true;
    });
  }, [stock, dep, q, soloConStock]);

  async function guardar(s: StockConsolidado) {
    const raw = conteo[s.producto_id];
    if (raw === undefined || raw === "") return;
    const contada = Math.max(0, Math.round(Number(raw) || 0));
    setSaving(s.producto_id);
    try {
      await api.ajusteInventario(s.producto_id, depId(dep), contada);
      setConteo((c) => { const n = { ...c }; delete n[s.producto_id]; return n; });
      await load();
      const sis = s.por_deposito[dep] ?? 0;
      const d = contada - sis;
      notify(d === 0 ? `${s.sku}: sin diferencia` : `${s.sku}: ajustado ${d > 0 ? "+" : ""}${d}`);
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Inventario</span><h2>Conteo físico</h2></div>
        <span className="muted">Ajustá el stock a lo que contás</span>
      </div>

      <div className="filters">
        <select className="select" value={dep} onChange={(e) => setDep(e.target.value)}>
          {deps.map((d) => <option key={d.id} value={d.codigo}>{d.codigo} · {d.nombre}</option>)}
        </select>
        <input className="input grow" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={soloConStock} onChange={(e) => setSoloConStock(e.target.checked)} /> Solo con stock</label>
      </div>

      <div className="card">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr><th>Producto</th><th style={{ textAlign: "right" }}>Sistema ({dep})</th><th style={{ textAlign: "right" }}>Contado</th><th style={{ textAlign: "right" }}>Dif.</th><th></th></tr>
            </thead>
            <tbody>
              {filas.length === 0 && <tr><td colSpan={5} className="empty">Sin productos en este depósito.</td></tr>}
              {filas.map((s) => {
                const sis = s.por_deposito[dep] ?? 0;
                const raw = conteo[s.producto_id];
                const dif = raw !== undefined && raw !== "" ? Math.round(Number(raw) || 0) - sis : null;
                return (
                  <tr key={s.producto_id}>
                    <td className="sku">{s.sku}<small>{s.nombre}</small></td>
                    <td className="tnum" style={{ textAlign: "right" }}>{sis}</td>
                    <td style={{ textAlign: "right" }}>
                      <input className="input qtybox" type="number" min={0} value={raw ?? ""} placeholder="—"
                        onChange={(e) => setConteo((c) => ({ ...c, [s.producto_id]: e.target.value }))} />
                    </td>
                    <td className="tnum mono" style={{ textAlign: "right", color: dif == null ? "var(--ink-faint)" : dif === 0 ? "var(--ok)" : "var(--bad)", fontWeight: 700 }}>
                      {dif == null ? "—" : (dif > 0 ? "+" : "") + dif}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn ghost btn-sm" disabled={saving === s.producto_id || raw === undefined || raw === ""} onClick={() => guardar(s)}>
                        {saving === s.producto_id ? "…" : "Ajustar"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
