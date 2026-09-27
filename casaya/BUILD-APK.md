# Esta semana: activar los dos paneles + compilar el APK de prueba

Este documento asume que tenés Flutter, el SDK de Android y `firebase-tools` instalados en tu máquina. Si no los tenés: `flutter.dev/docs/get-started/install` y `npm install -g firebase-tools`.

## 1. Activar "Payouts" en el panel de Mercado Pago

Es un producto aparte del marketplace de pagos con split que ya usamos para el OAuth — tiene su propia alta, y sin ella `POST /v1/payouts` falla aunque el resto de las credenciales esté bien.

1. Entrá a [mercadopago.com.ar/developers](https://www.mercadopago.com.ar/developers/panel) con la cuenta de la aplicación (no la personal).
2. En **Tus integraciones**, la app que ya usás para el OAuth de vinculación de técnicos debería tener una sección de **Payouts** o **Transferencias de dinero** — si no la ves, puede hacer falta crear una integración nueva específica de tipo Payouts dentro de la misma cuenta.
3. Seguí el asistente: suele pedir confirmar el `notification_url` (usá `MP_PAYOUT_WEBHOOK_URL` de tu `.env`, o el mismo `MP_WEBHOOK_URL` si no lo separaste) y aceptar los términos del producto.
4. Confirmá que estás en **modo sandbox/pruebas**, no en producción — la cuenta de prueba del vendedor (el técnico) tiene que ser una cuenta de test de Mercado Pago, no una real.

**Si el menú no coincide exactamente con esto:** la interfaz de Mercado Pago cambia con cierta frecuencia y no tengo forma de verificarla en vivo. Si no encontrás la opción, buscá "Payouts" en la documentación de developers.mercadopago.com — ahí está el flujo de alta actualizado. Si seguís sin encontrarla, es candidato a hablar directo con soporte de Mercado Pago: en algunos países Payouts requiere aprobación caso por caso, no es autoservicio para toda cuenta.

**Mientras esto no esté activo:** el resto del flujo funciona igual, pero cualquier solicitud se queda en `transactions.status = 'captured'` — el dinero se retiene y se cobra, pero la transferencia al técnico nunca sale. `retryStuckPayouts` la va a reintentar solo cada 30 minutos una vez que actives esto, sin que haga falta tocar nada más.

## 2. Activar el inicio de sesión por teléfono en Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → tu proyecto → **Authentication** → pestaña **Sign-in method**.
2. Habilitá **Phone** en la lista de proveedores.
3. Si vas a probar en un emulador de Android (no un teléfono físico), agregá tu propio número en **Phone numbers for testing** con un código fijo — así no gastás SMS reales de la cuota gratuita mientras probás. En un teléfono físico esto no hace falta, el SMS llega de verdad.
4. **Android:** Firebase Auth con teléfono necesita [Play Integrity](https://firebase.google.com/docs/auth/android/phone-auth#test-with-fake-numbers) configurado, o vas a ver un reCAPTCHA de respaldo la primera vez — es normal, no rompe el flujo, solo agrega un paso.
5. **iOS:** si vas a probar ahí más adelante, hace falta habilitar las notificaciones push silenciosas (APNs) para la verificación sin reCAPTCHA — para esta semana, con Android alcanza.

## 3. Preparar el proyecto para compilar (una sola vez)

El código que tenés en `app/lib/` y `app/pubspec.yaml` es la fuente Dart, pero todavía no es un proyecto Flutter *scaffolded* — le faltan las carpetas `android/` e `ios/` completas con sus archivos de Gradle/Xcode, que `flutter create` genera solo. Esto se hace una vez:

```bash
cd casaya/app

# Genera android/, ios/, y los archivos de plataforma que faltan, sin tocar
# lib/ ni pubspec.yaml (ya existen, así que flutter create los respeta).
flutter create --platforms=android,ios --org com.casaya .

# Conecta el proyecto a tu Firebase real: genera firebase_options.dart y
# registra las apps Android/iOS en la consola si no existían.
dart pub global activate flutterfire_cli
flutterfire configure
```

`flutterfire configure` te va a preguntar qué proyecto de Firebase usar y para qué plataformas — elegí el mismo proyecto donde ya desplegaste las Cloud Functions.

### Aplicar el deep link de Mercado Pago

Los dos fragmentos ya están preparados en el repo — hay que fusionarlos a mano en los archivos que acaba de crear `flutter create`, porque son fragmentos, no reemplazos completos:

- `android/app/src/main/AndroidManifest-payout-link.xml` → copiá el `<intent-filter>` de adentro de `<activity>` al `AndroidManifest.xml` real que generó `flutter create` (al lado del `<intent-filter>` del launcher, no en lugar de).
- `ios/Runner/Info-payout-link.plist` → copiá la key `CFBundleURLTypes` al `Info.plist` real, dentro del `<dict>` raíz.

### Instalar las dependencias y generar el ícono

```bash
flutter pub get
dart run flutter_launcher_icons
```

Esto reemplaza los íconos default de Flutter por el temporal que generamos (`assets/icon/icon_temp.png`) en todas las resoluciones que necesita Android e iOS.

## 4. Compilar el APK de prueba

```bash
flutter build apk --debug
```

Un APK **debug** (no `--release`) es lo correcto para esta semana: no pide firma con keystore, instala directo, y viene con más información de diagnóstico si algo falla a mitad de una prueba — justo lo que sirve mientras se recorre el flujo por primera vez. El archivo queda en:

```
app/build/app/outputs/flutter-apk/app-debug.apk
```

Para instalarlo en tu teléfono, cualquiera de estas tres:

- **Con el teléfono conectado por USB y depuración habilitada:** `flutter install` desde `casaya/app` lo instala directo.
- **Sin cable:** subí el `.apk` a Drive o mandátelo por cualquier chat, abrilo desde el teléfono y aceptá instalar de "fuentes desconocidas" cuando lo pida (es la advertencia normal de Android para cualquier APK fuera de Play Store).
- **Con el emulador de Android Studio abierto:** arrastrar el `.apk` directo a la ventana del emulador también instala.

## 5. Qué vas a poder probar esta semana — y qué todavía no

**Funciona de punta a punta:** login por teléfono con SMS real, elegir categoría y servicio, armar la solicitud con fotos y ubicación, ver la cotización en vivo, el despacho por geolocalización asignando un técnico, el mapa de seguimiento en tiempo real, el botón de pánico, el check-in/check-out del técnico, y el panel de administración completo con la cola de disputas.

**Todavía no vas a poder probar:** el pago real de la solicitud. `_selectedPaymentMethodId()` en `new_request_screen.dart` sigue devolviendo un valor fijo (`'pm_default'`) porque falta la última pieza: tokenizar una tarjeta de prueba del lado del cliente, que en Mercado Pago se hace con su SDK de Checkout Bricks corriendo en un WebView — no es algo que se pueda simular con un atajo sin dejar de probar justo la parte que más importa. Es la pieza que sigue, bien acotada, para que puedas probar el ciclo de dinero completo (retención → captura → transferencia → webhook) con una tarjeta de prueba real de Mercado Pago, no algo simulado.

Si querés, la armamos apenas termines esta ronda de pruebas — es una sola pantalla nueva, no toca nada de lo que ya está funcionando.
