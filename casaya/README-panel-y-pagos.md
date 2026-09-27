# Panel de operaciones y Mercado Pago

Segunda entrega: resolución de disputas y cobro local. Se apoya sobre el código de la primera y no la reemplaza.

## Archivos nuevos

```
functions/src/
├── services/payments/
│   ├── gateway.ts          Interfaz común: hold, capture, refund, voidHold, fetchStatus
│   ├── mercadopago.ts      Adaptador: preautorización, split marketplace, OAuth, firma del webhook
│   └── index.ts            Elige pasarela por país y renueva tokens de vendedor
├── domain/disputes.ts      Reparto del dinero y sugerencia de resolución (lógica pura)
└── http/
    ├── webhooks.ts         Endpoint de Mercado Pago con firma verificada y deduplicación
    └── admin.ts            Cola, expediente, previsualización, resolución, KYC, suspensiones

admin/                      Panel web (Vite + React), se despliega aparte de la app
├── src/api.ts              Único puente con el backend: solo callables, nunca Firestore directo
├── src/App.tsx             Shell, login y métricas de la operación
├── src/DisputeQueue.tsx    Cola ordenada por reloj de liberación
├── src/DisputeDetail.tsx   Expediente a la izquierda, decisión a la derecha
└── src/styles.css
```

## Cómo funciona el escrow en Mercado Pago

No es igual a Stripe y eso cambia el diseño en tres puntos.

**La retención es un pago con `capture: false`.** Queda en estado `authorized`: el importe está reservado en la tarjeta pero no cobrado. Al liberar se hace `PUT /v1/payments/{id}` con `capture: true`. Se puede capturar menos de lo autorizado, lo que resuelve elegantemente el reparto parcial de una disputa: se captura la parte del técnico y la diferencia se libera sola en la tarjeta del cliente, sin devolución.

**El split necesita OAuth del técnico.** El pago se crea con el access token del técnico y la plataforma retiene su comisión vía `application_fee`, identificándose con el header `X-Meli-Sponsor-Id`. Sin esa vinculación, la plataforma termina cobrando por cuenta de terceros, que es el peor lugar donde estar fiscalmente. Los tokens caducan y se renuevan solos antes de cada uso.

**La preautorización dura menos.** Unos 7 días como referencia, contra los 7 de Stripe pero con más variación según el banco emisor. Por eso la liberación automática está en 72 horas: hay que capturar con margen antes de que la reserva caduque, o el dinero se suelta y el técnico no cobra.

Un límite que conviene tener presente desde el principio: `capture: false` solo existe para tarjeta. Con dinero en cuenta, transferencia o efectivo no hay preautorización. El comentario al pie de `mercadopago.ts` describe el modo de custodia contable para esos casos, pero implica manejar dinero de terceros en una cuenta propia y probablemente encuadre regulatorio. Mi recomendación es arrancar solo con tarjeta.

## El panel

**La cola se ordena por el reloj del escrow, no por antigüedad.** Un reclamo cuyo pago se libera solo en cuatro horas es más urgente que uno abierto la semana pasada sobre dinero quieto: pasado ese plazo el dinero se fue y resolver bien deja de ser posible. El reloj se pone rojo abajo de las 12 horas.

**El sistema sugiere, la persona decide.** `suggestResolution` cruza la evidencia (hay check-in, hay fotos, cuántos minutos estuvo en el domicilio, cuántos reclamos previos tiene cada parte) y propone un resultado con su fundamento escrito. Automatizar la decisión produce dos daños a la vez: técnicos castigados por reclamos falsos y clientes obligados a pagar trabajos que no se hicieron.

**El reparto se calcula en el servidor y se muestra antes de confirmar.** `computeSettlement` falla si la suma no da exactamente el monto retenido. Un centavo perdido por resolución es un descuadre que aparece seis meses después y ya no se puede reconstruir. El panel no duplica la fórmula: la pide en cada cambio del control deslizante.

**Toda acción exige fundamento escrito y queda en `admin_audit`** con el correo de quien la tomó. Un panel que mueve dinero sin auditoría es una puerta abierta hacia adentro.

Una decisión que quizá quieras revisar: la plataforma renuncia a su comisión en casi todos los escenarios de conflicto. Cobrar por intermediar un servicio que salió mal es la forma más rápida de perder a las dos partes. Si preferís otro criterio, está todo en `computeSettlement` y en ningún otro lugar.

## Webhook

Es la única fuente confiable sobre el estado del dinero: un pago cambia sin que nadie toque la app cuando el antifraude lo aprueba tarde, el banco lo rechaza o el titular abre un contracargo.

- Firma HMAC verificada antes de leer el contenido, con ventana de 5 minutos contra reenvíos.
- Deduplicado por `x-request-id` usando `create()` como candado: Mercado Pago reintenta y la misma notificación puede llegar varias veces.
- El cuerpo solo trae el id; el estado se consulta a la API. Confiar en el payload es confiar en quien lo envía.
- Siempre responde 200. Un contracargo abre un reclamo automático con prioridad alta y toda la evidencia ya reunida.

## Puesta en marcha

```bash
# Backend
cd functions
npm install
# completar las variables MP_* en .env
firebase deploy --only functions,firestore:rules

# Registrar el webhook en el panel de Mercado Pago apuntando a:
#   https://southamerica-east1-<proyecto>.cloudfunctions.net/mercadoPagoWebhook
# y copiar la clave secreta que genera a MP_WEBHOOK_SECRET

# Dar de alta al primer administrador (una sola vez, desde una consola de confianza)
node -e "require('firebase-admin').initializeApp(); \
  require('firebase-admin').auth().setCustomUserClaims('<UID>', { role: 'admin' })"

# Panel
cd ../admin
npm install
cp .env.example .env     # completar con la config del proyecto
npm run dev              # local
npm run build            # producción
```

El panel se despliega en un hosting separado del sitio público, idealmente detrás de una restricción de IP o de un acceso corporativo. El claim de rol lo verifica el backend en cada llamada, pero no conviene dejar la URL a la vista.

## Qué queda pendiente

- **Vinculación OAuth del técnico en la app.** El backend ya sabe canjear el código y renovar tokens (`exchangeOAuthCode`, `refreshSellerToken`); falta la pantalla en Flutter que abre el consentimiento y recibe el redirect.
- **Conciliación diaria.** Un job que compare `transactions` contra el reporte de liquidaciones de Mercado Pago y levante las diferencias. Sin eso, un webhook perdido queda invisible hasta que alguien reclama.
- **Respuesta automática al contracargo.** El expediente ya reúne la evidencia (GPS, fotos, PIN verificado); falta armar el paquete y enviarlo por la API de disputas del proveedor dentro del plazo, que es corto.
- **Retenciones impositivas.** En Argentina, según cómo se liquide, pueden aplicar percepciones y retenciones sobre la comisión. Conviene resolverlo con un contador antes de facturar el primer mes, porque cambia el cálculo de `platformFee`.
