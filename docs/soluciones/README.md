# Soluciones — Innovalport / Cominarsa

Diseño de las soluciones a construir para el negocio. La prioridad #1, convergente en todo el relevamiento, es la **gestión de stock**.

- [`stock.md`](./stock.md) — diagnóstico operativo de la solución de stock (as-is → causas raíz → to-be → roadmap), construido desde el relevamiento (principalmente Javier, cruzado con Martín y Tomás).
- [`arquitectura-tecnica-stock.md`](./arquitectura-tecnica-stock.md) — arquitectura técnica ya resuelta en una sesión de diseño previa: investigación de las APIs (Contabilium, ML, Tienda Nube), decisión de Contabilium como fuente de verdad + capa "Centro de Stock" encima, stack (Supabase + Edge Functions + panel React), y el inventario de artefactos que se diseñaron. **Contiene una advertencia importante: ese código se diseñó pero nunca llegó a este repo.**

Ambos documentos de stock se leen juntos: uno es el "qué problema y por qué", el otro es el "cómo se construye".

## Visión de largo plazo

El objetivo final declarado (ver chat de diseño inicial en [`../relevamiento/chat-diseno-inicial.md`](../relevamiento/chat-diseno-inicial.md)) es un **agente que sea "la segunda cabeza del negocio"**: integral, consultable, capaz de correr análisis y reportes sobre todos los datos, y base para microservicios que automaticen procesos. La solución de stock es el primer microservicio de esa visión. El resto del backlog priorizado está en [`../contexto-negocio.md`](../contexto-negocio.md) §11.
