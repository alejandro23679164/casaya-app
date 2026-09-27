import 'dart:async';
import 'package:app_links/app_links.dart';
import 'package:go_router/go_router.dart';

/// Puente entre el sistema operativo y `go_router`.
///
/// `go_router` sabe navegar; no sabe escuchar al sistema operativo. Ese es el
/// trabajo de `app_links`: capta el `casaya://cobros?...` tanto si llega con
/// la app abierta como si la app estaba cerrada del todo y el enlace fue lo
/// que la lanzó (ese segundo caso es el que se olvida más seguido, y es
/// exactamente el que ocurre cuando alguien vuelve del navegador después de
/// autorizar en Mercado Pago con la app en segundo plano hace rato).
///
/// Solo traduce `casaya://<host>/<path>?query` a la ruta interna equivalente
/// y deja que `go_router` haga el resto. No conoce el significado de `code` ni
/// de `state`: eso lo interpreta la pantalla que recibe la ruta.
class DeepLinkHandler {
  DeepLinkHandler(this._router);

  final GoRouter _router;
  final _appLinks = AppLinks();
  StreamSubscription<Uri>? _sub;

  /// Se llama una sola vez, en el arranque de la app.
  Future<void> start() async {
    // Enlace que lanzó la app desde frío. Si no hubo ninguno, es null y no
    // pasa nada — el arranque normal sigue por `initialLocation`.
    final initial = await _appLinks.getInitialLink();
    if (initial != null) _handle(initial);

    // Enlaces que llegan con la app ya corriendo (abierta o en 2º plano).
    _sub = _appLinks.uriLinkStream.listen(_handle, onError: (_) {
      // Un enlace malformado no debe tirar abajo la app; simplemente se
      // ignora y la persona sigue en la pantalla en la que estaba.
    });
  }

  void dispose() => _sub?.cancel();

  void _handle(Uri uri) {
    if (uri.scheme != 'casaya') return;

    // casaya://cobros?code=...&state=...  →  host = "cobros"
    // Mapeado explícito en vez de genérico: agregar un nuevo destino de deep
    // link es una línea acá, y evita que una ruta interna cualquiera quede
    // alcanzable desde afuera sin querer.
    final target = switch (uri.host) {
      'cobros' => '/tecnico/cobros',
      _ => null,
    };
    if (target == null) return;

    final query = uri.queryParameters.isEmpty ? '' : '?${uri.query}';
    _router.go('$target$query');
  }
}
