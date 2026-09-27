import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/deep_links.dart';
import 'core/theme.dart';
import 'data/repositories.dart';
import 'features/auth/phone_auth_screen.dart';
import 'features/client/category_picker_screen.dart';
import 'features/client/new_request_screen.dart';
import 'features/client/tracking_screen.dart';
import 'features/tech/active_job_screen.dart';
import 'features/tech/job_feed_screen.dart';
import 'features/tech/payout_link_screen.dart';

/// Una sola base de código para iOS, Android y web.
///
/// go_router da URLs reales en el navegador (/solicitud/abc123 es enlazable y
/// compartible) y deep links en móvil con la misma tabla de rutas.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  runApp(const ProviderScope(child: CasaYaApp()));
}

class CasaYaApp extends ConsumerStatefulWidget {
  const CasaYaApp({super.key});

  @override
  ConsumerState<CasaYaApp> createState() => _CasaYaAppState();
}

class _CasaYaAppState extends ConsumerState<CasaYaApp> {
  late final GoRouter _router;
  DeepLinkHandler? _deepLinks;

  @override
  void initState() {
    super.initState();
    _router = _buildRouter(ref);

    // El manejador de deep links necesita el router ya construido para poder
    // navegar cuando llegue casaya://cobros, así que arranca después, no
    // dentro de build(). En web no hace nada (app_links no escucha ahí; el
    // redirect vuelve por query string a la misma ruta, que ya sabe leerlo).
    _deepLinks = DeepLinkHandler(_router)..start();
  }

  @override
  void dispose() {
    _deepLinks?.dispose();
    super.dispose();
  }

  GoRouter _buildRouter(WidgetRef ref) {
    return GoRouter(
      initialLocation: '/',
      // Sin sesión, cualquier ruta cae en /ingresar; con sesión, /ingresar
      // redirige a la home del rol.
      redirect: (context, state) {
        final signedIn = ref.read(currentUserIdProvider) != null;
        final goingToAuth = state.matchedLocation == '/ingresar';
        if (!signedIn && !goingToAuth) return '/ingresar';
        if (signedIn && goingToAuth) return '/';
        return null;
      },
      routes: [
        GoRoute(path: '/', builder: (_, __) => const CategoryPickerScreen()),
        GoRoute(path: '/ingresar', builder: (_, __) => const PhoneAuthScreen()),
        GoRoute(
          path: '/nueva-solicitud/:serviceId',
          builder: (_, s) => NewRequestScreen(serviceId: s.pathParameters['serviceId']!),
        ),
        GoRoute(
          path: '/solicitud/:id',
          builder: (_, s) => TrackingScreen(requestId: s.pathParameters['id']!),
        ),
        GoRoute(path: '/trabajos', builder: (_, __) => const JobFeedScreen()),
        GoRoute(
          path: '/trabajo/:id',
          builder: (_, s) => ActiveJobScreen(requestId: s.pathParameters['id']!),
        ),
        // Destino del redirect de Mercado Pago. En web llega directo como
        // query string en esta misma URL; en móvil, DeepLinkHandler traduce
        // casaya://cobros?... a esta misma ruta antes de que go_router la vea.
        GoRoute(
          path: '/tecnico/cobros',
          builder: (_, s) => PayoutLinkScreen(
            incomingCode: s.uri.queryParameters['code'],
            incomingState: s.uri.queryParameters['state'],
            incomingError: s.uri.queryParameters['error'],
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'CasaYa',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      routerConfig: _router,
    );
  }
}

