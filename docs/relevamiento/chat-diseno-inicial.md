# Chat de diseño inicial (claude.ai)

Transcripción de la conversación previa (en claude.ai, antes de este repo) donde se definió la visión del agente "segunda cabeza del negocio" y se diseñó la solución de stock. Es una fuente primaria: fija el objetivo, el contexto original que dio la usuaria (Mora), y las decisiones tomadas. La sustancia técnica está sintetizada en [`../soluciones/arquitectura-tecnica-stock.md`](../soluciones/arquitectura-tecnica-stock.md).

## Objetivo declarado por la usuaria

> "Quiero armar un agente que sea la segunda cabeza del negocio, que conozca todo, absolutamente integral, sobre el cual se pueda hacer consultas, correr análisis y reportes, interactuar con absolutamente todos los datos, y se pueda construir microservicios para automatizar y optimizar procesos. Quiero que el agente sea el cerebro del negocio, es un emprendimiento que está empezando, se compone de muy pocas personas."

## Contexto original aportado (base del relevamiento)

- **Cominarsa** = sociedad importadora (China → Argentina): cámaras de seguridad, timbres, bachas, robots de cocina, varios.
- **Innovalport** = marca de venta: Mercado Libre (principal), Tienda Nube, Instagram. Facturación y stock en **Contabilium**.
- Equipo: Martín (cabeza), el Negro (impo, saliendo por problemas), Tomás (publicaciones/ML), Carla (post-venta/redes), Javier (operativo: stock a depósitos, algo de post-venta/devoluciones), Bautista (socio, capital).
- Proveedores: idealmente China; también compran en Once a **LLM/Mati**; retiran de **LBS o Mati**.

## Flujo de stock que describió la usuaria (base del diseño)

**Ingreso:** 1) Impo → llega a Genpol. 2) Proveedores locales → LBS o Mati → lo buscan. Se carga factura o remito en Contabilium (papel o PDF) para dar de alta stock; ahí se decide destino: Flexit, Full, Genpol u Oficina.

**Movimiento:** se puede cambiar stock de depósito; siempre se genera un remito.

**Egreso:** 1) Mercado Libre. 2) Tienda Nube. 3) Devoluciones:
- Se carga X cantidad con el SKU de devoluciones al depósito correspondiente; automáticamente se genera el remito para retirarlo.
- De ahí SIEMPRE vuelven a la oficina: aptas y no aptas.
- Punto a chequear: en teoría debería generar una nota de crédito automáticamente y volver a figurar en stock (interno, no en la plataforma de venta).
- No aptas → baja de todo tipo de stock. Aptas → alta en el depósito correspondiente (ingreso sin compra).

## Lo que la usuaria pidió construir (cita)

> "Diseñá un sistema automatizado que sea súper simple de manejar, conectando todas las APIs (Contabilium de hecho ya tiene integración con Mercado Libre y Tienda Nube, manejo de distintos depósitos, etc). Quiero que investigues bien cada API, me pidas todo lo que necesites, diseñes toda la arquitectura de la automatización, y me digas si hay que construir un backend / frontend lo que sea, construilo para que haya un solo lugar, con todo consolidado, y resuelva el problema del stock 100% siendo fácil de usar sin tener que caer en cargar las cosas en Contabilium que es una paja."

## Decisiones y entregables de esa sesión

1. Se generó un **cuestionario de relevamiento integral** (que derivó en las respuestas de Martín/Tomás/Carla/Javier guardadas en esta carpeta).
2. Se investigaron las 3 APIs y se decidió la arquitectura: **Contabilium como fuente de verdad + capa "Centro de Stock" encima** (detalle en `arquitectura-tecnica-stock.md`).
3. Se diseñaron y "construyeron" los artefactos (panel React, schema Supabase, 2 edge functions, script de test, README).
4. **La sesión terminó sin poder pushear al repo** (Claude no tenía credenciales de GitHub). Se le ofreció a la usuaria subir un zip o pasar un PAT. El repo quedó vacío → es la brecha que documenta `arquitectura-tecnica-stock.md` §6.

## Estado confirmado por la usuaria en esa sesión

- ✅ Plan de Contabilium es **Full**.
- ✅ Tiene la **API Key** de Contabilium.
- Creó el repo `github.com/morabessone/innovalport` y pidió subir todo y las instrucciones para correrlo y conectarlo a Contabilium.

> Nota sobre una ambigüedad detectada en esa sesión y no resuelta: en el mensaje original aparecen "LLM y Mati" como proveedores pero "LBS o Mati" como puntos de retiro. En el relevamiento posterior, Martín aclaró **Maty** (proveedor de Once, cuenta corriente) y **LBS** (proveedor de línea de hogar de ticket bajo, contado) como dos actores distintos; "LLM" no reapareció — probablemente era el mismo LBS. A confirmar.
