# Contexto de negocio — Cominarsa / Innovalport

Documento maestro de síntesis, construido a partir del relevamiento de julio 2026 a Martín, Javier, Tomás y Carla (ver [`./relevamiento/`](./relevamiento/) para las respuestas completas sin resumir). Sigue la estructura tentativa que el propio cuestionario de relevamiento proponía para el "cerebro" del negocio.

Este documento es la base para diagramar cualquier solución (agente, automatización, o el sistema de stock que es la prioridad actual — ver [`./soluciones/stock.md`](./soluciones/stock.md)).

## 1. Identidad y estrategia

- **Cominarsa S.A.**: sociedad importadora (China → Argentina). **Innovalport**: marca de venta al consumidor final.
- Canales: Mercado Libre (principal), Tienda Nube (~10% de ventas, reactivándose), Instagram (solo consultas/derivación, sin venta directa).
- Modelo actual: importar barato y vender con margen por volumen en ML, mientras se construye marca para impulsar Tienda Nube. Propuesta de valor hoy: **solo precio y posicionamiento por pauta** — sin diferenciación real todavía.
- Facturación: muy variable, **$55M–$250M/mes**, limitada por disponibilidad de stock y capital de trabajo. Objetivo del año: **$280M/mes estables durante 12 meses**.
- Solo venta minorista (no B2B/mayorista). Sin estacionalidad marcada. Todo se factura por Cominarsa.
- Socios: Martín Bessone y Bautista Irigoyen (un tercer socio, Santiago "el Negro", está en proceso de desvinculación).

## 2. Organigrama y responsabilidades

| Persona | Rol | Punto único de falla declarado |
|---|---|---|
| **Martín** | Cabeza del negocio, compras, precios, finanzas, decide qué/cuánto importar, absorbe importación tras la salida de Santiago | Información financiera/rentabilidad, contactos con proveedores chinos |
| **Santiago ("el Negro")** | Importación (saliendo del negocio) | Contactos WeChat de proveedores chinos, relación con forwarder/despachante — **transición urgente, no relevado todavía** |
| **Tomás** | Publicaciones ML, precios, pauta (Mercado Ads), reposición a Full/Flex desde su óptica de ventas | Publicaciones nuevas, manejo de pauta |
| **Carla** | Post-venta, atención al cliente (ML/WhatsApp/IG), reclamos, contenido/diseño, redes | Toda la reputación y continuidad de atención al cliente |
| **Javier** | Logística física: retiro a proveedores, movimiento entre depósitos, carga en Contabilium, devoluciones físicas | **Casi todos los movimientos de Contabilium y el control de stock** |
| **Bautista** | Socio, consigue capital | — (no relevado en esta ronda) |

Decisiones grandes las toma Martín. Nadie concilia lo que ML liquida contra lo vendido. Nadie reclama garantía a proveedores por fallas.

## 3. Catálogo

- ~30 SKUs activos, coinciden entre Contabilium/ML/TN. Convención: `PRODUCTO-PORT` (importado) o `SKU-PORT` (proveedor local).
- Un SKU por variante. Existen combos/kits con descuento de stock automático vía Contabilium.
- **80% de la facturación**: inodoros, bachas y duchadores inteligentes (el core de marca). El resto: cámaras de seguridad, timbres, robots de cocina, "varios".
- Sin requisitos regulatorios. Garantía: 30 días propios + plazo ML (6 meses en robot de cocina e inodoro inteligente). Sin manuales técnicos guardados en ningún lado.

## 4. Cadena de abastecimiento

**Importación (China, vía Alibaba):**
Pedido + anticipo (20%, ~1 semana) → fabricación (15-30 días) → saldo + forwarder (~1 semana) → consolidación (~10 días) → tránsito marítimo (~45 días) → despacho en Genpol (~10 días). **Lead time total: 90-100 días.** Sin control de calidad en origen. Planificación por intuición, no forecast — "todo el tiempo" se quedan sin stock de productos que venden bien. Están migrando a pedidos más chicos cada 15-20 días.

**Proveedores locales (Once/Parque Patricios):**
- **Maty**: cuenta corriente 30-45 días.
- **LBS**: contado, línea de hogar de ticket bajo (ayuda a sostener reputación ML).
- Margen local ~10% (contribución marginal) vs. 19-20% en importado.
- Javier retira con su camioneta; a veces se carga solo con remito (sin factura A).

## 5. Mapa de stock

Ver documento dedicado: [`./soluciones/stock.md`](./soluciones/stock.md). Resumen de depósitos:

| Depósito | Qué es | Rol |
|---|---|---|
| Genpol (Don Torcuato) | Depósito fiscal de terceros, alquilado. Encargado: Sergio. | Recibe importación, depósito general, origen de envíos a Flexit y colecta de Full |
| Flexit (Monserrat) | Operador logístico de terceros | Despacha ventas Flex de ML y Tienda Nube |
| Full | Depósitos propios de Mercado Libre | Recibe stock preparado desde Genpol; ML hace la colecta |
| Oficina (Olivos/Vicente López — a confirmar) | Propia | Poco stock; ahí se revisan devoluciones |

**Este es el punto más crítico y menos maduro de todo el negocio** — ver diagnóstico completo en `soluciones/stock.md`.

## 6. Canales de venta

- **Mercado Libre**: cuenta única "Innovalport", Platinum. Mix logístico Full ~60-80% / Flex el resto (Martín y Tomás dan cifras algo distintas — a validar). Integración con Contabilium: descuenta stock automático **solo en algunos productos**; en el resto es manual (causa de sobreventa). No factura automáticamente desde ML. Mercado Ads: ~$3M/mes, gestionado por Tomás + asesor externo (Toto).
- **Tienda Nube**: ~10% de ventas, integrada con Contabilium (stock y facturación automáticos), logística también por Flexit.
- **Instagram/WhatsApp**: solo consulta y derivación, sin venta directa ni catálogo activo.
- Todo se factura por Contabilium (Factura B). Notas de crédito las emite Contabilium por devoluciones (aunque en la práctica ML rara vez llega a ese paso).

## 7. Post-venta y devoluciones

- Carla gestiona todo el front de atención (ML principal, luego WhatsApp/IG, mail casi nada). ~10 devoluciones/semana, ~2% de las ventas. Top motivos: expectativa no cumplida, problemas de instalación/compatibilidad, daño en el envío. Top productos devueltos: cámaras, proyectores, productos con batería.
- **Estado real declarado por Martín: "No se hace nada con las devoluciones, hay que implementar todo."** No hay SKU de devolución, no hay criterio escrito de apto/no apto, no hay decisión sobre destino de las no aptas (se acumulan en la oficina), no se mide la pérdida.
- Sin reclamo formal de garantía a proveedores.

## 8. Finanzas

- Cuentas: banco Cominarsa + Mercado Pago (acceso Martín, y Tomás en MP). **Nadie concilia lo que ML liquida contra lo vendido.**
- Contabilidad externa: estudio de Claudio. Cash flow manejado "al día" por Martín, sin proyección formal.
- Deuda: capital de trabajo con tasas altas, renovación anual — pagado pese a rentabilidad real no confirmada por los problemas de compra/stock del período anterior.
- IVA a favor, situación impositiva al día.

## 9. Sistemas y fuentes de verdad

- **Contabilium** (plan más alto): factura y controla stock, pero **nadie sabe usarlo bien** y no hay capacitación prevista. Costos cargados "sucios" (no reflejan costo real con impuestos/despacho), lo que distorsiona el margen calculado.
- Sin CRM. Coordinación operativa vía un grupo general de WhatsApp (incluida la logística de stock — fotos de remitos, avisos de movimientos).
- **Las planillas Excel y Contabilium no coinciden entre sí** — no hay una fuente de verdad única.
- Sin desarrollos previos ni automatizaciones — este relevamiento es el punto de partida.

## 10. Glosario

- **Genpol**: depósito fiscal de terceros en Don Torcuato, encargado Sergio. Depósito general de la operación.
- **Flexit**: operador logístico de terceros (Monserrat) para envíos Flex de ML y web.
- **Full**: la logística propia de Mercado Libre (distinta de Flexit).
- **Flex**: modalidad de envío de ML despachada por Flexit (no confundir con Full).
- **LBS / Maty (Mati)**: proveedores locales de Once/Parque Patricios.
- **El Negro**: Santiago, socio saliente a cargo de importación.
- **"Darle de alta" a un SKU**: dar de alta un producto nuevo en catálogo/publicación.

## 11. Dolores y backlog de automatización (priorizado)

Ranking según lo que cada persona respondió a "si pudieras automatizar UNA sola cosa":

1. **Gestión y control de stock** — mencionado de forma independiente y como prioridad #1 por **Martín** ("gestión de stock") y por **Javier** ("el control del stock, sin dudas" / "no saber concretamente la cantidad de stock que tenemos y en qué depósito"). Causa directa de sobreventa (Tomás: "pasa 3 veces por semana mínimo") y de quiebres recurrentes en Full/Flex. **Es el foco actual — ver `soluciones/stock.md`.**
2. **Devoluciones** — sin proceso, sin SKU, sin criterio, sin registro de pérdida. Depende de Carla/Javier/Martín ad-hoc.
3. **Atención al cliente repetitiva** (Carla) — consultas frecuentes de envío/estado/instalación automatizables con plantillas ya existentes.
4. **Conciliación financiera** (Martín) — nadie concilia liquidaciones de ML contra ventas; visibilidad de rentabilidad real.
5. **Carga de facturas/remitos por OCR** — candidato explícito en el cuestionario original para reducir la carga manual de Javier.

## 12. Permisos (pendiente de definir)

No definido todavía: matriz de qué puede ver cada persona (ej. si Carla debería ver márgenes/finanzas), método seguro de credenciales (gestor compartido / usuarios colaboradores de solo lectura en Contabilium, app en ML DevCenter, API de Tienda Nube).

## Huecos abiertos de este relevamiento

- Falta la respuesta de **Santiago ("el Negro")** — urgente por la transición de importación.
- Falta la mirada de **Bautista** sobre estructura societaria y capital.
- Evidencia pendiente (pedida en el cuestionario original): export de catálogo de Contabilium, export de ventas 12 meses, documentación de una importación completa, planilla de costeo, facturas/remitos reales, export de movimientos de stock, reporte de devoluciones, última liquidación de ML.
