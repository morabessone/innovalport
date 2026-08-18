// Dashboard de Inicio: la grilla de herramientas internas. Por ahora la única
// activa es Central de Stock; Publicaciones queda deshabilitada (Próximamente).
export function Home({ email, onOpen }: { email: string | null; onOpen: (tool: "stock") => void }) {
  return (
    <div className="home">
      <div className="home-hero">
        <span className="eyebrow-h">Inicio</span>
        <h1 className="home-title">Herramientas</h1>
        <p className="home-sub">
          {email ? <>Sesión iniciada como <b>{email}</b>. </> : null}
          Elegí una herramienta para empezar.
        </p>
      </div>

      <div className="tool-grid">
        <button className="tool tool-active" onClick={() => onOpen("stock")}>
          <div className="tool-top"><span className="tool-ico">📦</span></div>
          <h3>Central de Stock</h3>
          <p>Ver y ordenar el stock de Mercado Libre (Full y Flex) y Tienda Nube, con Contabilium como fuente de verdad.</p>
          <span className="tool-cta">Abrir <span aria-hidden="true">→</span></span>
        </button>

        <div className="tool tool-soon" aria-disabled="true">
          <div className="tool-top">
            <span className="tool-ico">🏷️</span>
            <span className="tool-badge">Próximamente</span>
          </div>
          <h3>Publicaciones</h3>
          <p>Gestión y control de las publicaciones en cada canal.</p>
          <span className="tool-cta faint">Disponible pronto</span>
        </div>
      </div>
    </div>
  );
}
