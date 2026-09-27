import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme.dart';

/// Vinculación de la cuenta de cobro del técnico.
///
/// Es la pantalla donde alguien entrega acceso a su cuenta de dinero, así que
/// el tono es distinto al del resto de la app: antes del botón se explica en
/// texto plano qué se autoriza y qué no. Un técnico que no entiende qué firmó
/// abandona acá, o peor, vincula y después desconfía del primer cobro.
///
/// El flujo difiere por plataforma y eso está resuelto abajo:
///  - Móvil: se abre el navegador del sistema y el redirect vuelve por deep
///    link (casaya://cobros?code=...&state=...).
///  - Web: el redirect vuelve a la misma URL con los parámetros en el query.
class PayoutLinkScreen extends ConsumerStatefulWidget {
  const PayoutLinkScreen({
    super.key,
    this.incomingCode,
    this.incomingState,
    this.incomingError,
  });

  /// Parámetros que trae el redirect. En web los inyecta el router desde la
  /// URL; en móvil, el manejador de deep links.
  final String? incomingCode;
  final String? incomingState;
  /// Presente cuando el técnico canceló el consentimiento en Mercado Pago en
  /// vez de completarlo. No es un error de nuestro lado: se muestra como tal.
  final String? incomingError;

  @override
  ConsumerState<PayoutLinkScreen> createState() => _PayoutLinkScreenState();
}

class _PayoutLinkScreenState extends ConsumerState<PayoutLinkScreen> {
  final _fn = FirebaseFunctions.instanceFor(region: 'southamerica-east1');

  Map<String, dynamic>? _status;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Si llegamos de vuelta del consentimiento, se canjea el código antes de
    // dibujar nada: el usuario no debería ver "no vinculado" por un instante.
    if (widget.incomingError != null) {
      // El técnico canceló en Mercado Pago en vez de autorizar. No hay nada
      // que canjear; se informa y se deja reintentar.
      _error = 'No se completó la conexión con Mercado Pago. Podés intentarlo de nuevo.';
      _loadStatus();
    } else if (widget.incomingCode != null) {
      _completeLink(widget.incomingCode!, widget.incomingState ?? '');
    } else {
      _loadStatus();
    }
  }

  Future<void> _loadStatus() async {
    try {
      final res = await _fn.httpsCallable('getPayoutLinkStatus').call();
      if (mounted) setState(() => _status = Map<String, dynamic>.from(res.data as Map));
    } catch (_) {
      if (mounted) setState(() => _error = 'No pudimos consultar el estado de tu cuenta.');
    }
  }

  Future<void> _startLink() async {
    setState(() { _busy = true; _error = null; });
    try {
      final res = await _fn.httpsCallable('startPayoutLink').call();
      final url = Uri.parse((res.data as Map)['authorizationUrl'] as String);

      // externalApplication abre el navegador del sistema, no una webview
      // embebida. Mercado Pago bloquea el login dentro de webviews, y además
      // pedirle a alguien que escriba su contraseña bancaria dentro de nuestra
      // app es exactamente lo que no hay que enseñar a hacer.
      final ok = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!ok) throw Exception('no se pudo abrir el navegador');
    } catch (e) {
      setState(() => _error = 'No pudimos abrir Mercado Pago. Revisá tu conexión.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _completeLink(String code, String state) async {
    setState(() { _busy = true; _error = null; });
    try {
      await _fn.httpsCallable('completePayoutLink').call({'code': code, 'state': state});
      await _loadStatus();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Cuenta vinculada. Ya podés recibir cobros.')),
        );
      }
    } on FirebaseFunctionsException catch (e) {
      // Los mensajes del backend ya están escritos para leerse; se muestran
      // tal cual en lugar de un genérico.
      setState(() => _error = e.message ?? 'No pudimos vincular la cuenta.');
      await _loadStatus();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlink() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Desvincular la cuenta'),
        content: const Text(
          'Dejás de recibir trabajos hasta que vuelvas a vincularla. '
          'Los pagos ya acreditados no se ven afectados.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Desvincular')),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() { _busy = true; _error = null; });
    try {
      await _fn.httpsCallable('unlinkPayoutAccount').call();
      await _loadStatus();
    } on FirebaseFunctionsException catch (e) {
      setState(() => _error = e.message ?? 'No pudimos desvincular la cuenta.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final linked = _status?['linked'] == true;

    return Scaffold(
      appBar: AppBar(title: const Text('Cómo cobrás')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md),
              children: [
                if (_status == null && _error == null)
                  const Padding(
                    padding: EdgeInsets.all(AppSpacing.xl),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (linked)
                  _LinkedCard(
                    status: _status!,
                    busy: _busy,
                    onUnlink: _unlink,
                  )
                else
                  _UnlinkedCard(busy: _busy, onStart: _startLink),

                if (_error != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  Container(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: AppColors.alarm.withOpacity(0.08),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(_error!, style: AppTypography.body.copyWith(color: AppColors.alarm)),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Estado sin vincular: explicación primero, botón después.
class _UnlinkedCard extends StatelessWidget {
  const _UnlinkedCard({required this.busy, required this.onStart});

  final bool busy;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Conectá tu Mercado Pago para cobrar', style: AppTypography.display),
        const SizedBox(height: AppSpacing.sm),
        const Text(
          'Cuando el cliente confirma el trabajo con su código, transferimos el pago a esta '
          'cuenta — ya con la comisión de la plataforma descontada. El dinero pasa un momento '
          'por CasaYa mientras se confirma el trabajo, nunca queda ahí más de lo necesario.',
          style: AppTypography.body,
        ),

        const SizedBox(height: AppSpacing.lg),
        const _PermissionRow(
          allowed: true,
          text: 'Transferirte lo que cobres por los trabajos que hagas',
        ),
        const _PermissionRow(
          allowed: true,
          text: 'Descontar la comisión de la plataforma antes de transferir',
        ),
        const _PermissionRow(
          allowed: false,
          text: 'Ver el saldo o los movimientos de tu cuenta',
        ),
        const _PermissionRow(
          allowed: false,
          text: 'Sacar dinero o hacer pagos en tu nombre',
        ),

        const SizedBox(height: AppSpacing.lg),
        FilledButton.icon(
          onPressed: busy ? null : onStart,
          icon: busy
              ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Icon(Icons.open_in_new, size: 18),
          label: const Text('Conectar con Mercado Pago'),
        ),
        const SizedBox(height: AppSpacing.sm),
        const Text(
          'Se abre el sitio de Mercado Pago para que inicies sesión ahí. '
          'Tu contraseña nunca pasa por esta app.',
          style: AppTypography.caption,
        ),
      ],
    );
  }
}

class _PermissionRow extends StatelessWidget {
  const _PermissionRow({required this.allowed, required this.text});

  final bool allowed;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              allowed ? Icons.check_circle_outline : Icons.block,
              size: 20,
              color: allowed ? AppColors.trust : AppColors.slate,
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                text,
                style: allowed
                    ? AppTypography.body
                    : AppTypography.body.copyWith(color: AppColors.slate),
              ),
            ),
          ],
        ),
      );
}

/// Estado vinculado. Muestra si falta algo más para recibir trabajos: tener la
/// cuenta conectada no alcanza si el KYC sigue en revisión, y no decirlo deja
/// al técnico esperando trabajos que nunca llegan.
class _LinkedCard extends StatelessWidget {
  const _LinkedCard({required this.status, required this.busy, required this.onUnlink});

  final Map<String, dynamic> status;
  final bool busy;
  final VoidCallback onUnlink;

  @override
  Widget build(BuildContext context) {
    final canWork = status['canReceiveJobs'] == true;
    final kyc = status['kycStatus'] as String?;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: AppColors.trust.withOpacity(0.08),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              const Icon(Icons.verified_outlined, color: AppColors.trust),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Cuenta de cobro conectada', style: AppTypography.bodyStrong),
                    Text(
                      status['email'] != null
                          ? 'Mercado Pago · ${status['email']}'
                          : 'Mercado Pago · ${status['mpUserId']}',
                      style: AppTypography.caption,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),

        if (!canWork) ...[
          const SizedBox(height: AppSpacing.md),
          Container(
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: AppColors.signal.withOpacity(0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Falta un paso para recibir trabajos', style: AppTypography.bodyStrong),
                const SizedBox(height: 2),
                Text(
                  switch (kyc) {
                    'in_review' => 'Estamos revisando tu documentación. Suele tardar menos de 24 horas.',
                    'rejected' => 'Tu verificación fue rechazada. Entrá a Verificación para ver el motivo.',
                    'suspended' => 'Tu cuenta está suspendida. Escribinos para revisarlo.',
                    _ => 'Completá la verificación de identidad para empezar.',
                  },
                  style: AppTypography.body,
                ),
              ],
            ),
          ),
        ],

        const SizedBox(height: AppSpacing.lg),
        const Text('Cómo se reparte cada trabajo', style: AppTypography.title),
        const SizedBox(height: AppSpacing.sm),
        const Text(
          'En cuanto el cliente confirma el trabajo con su código de 4 dígitos, iniciamos la '
          'transferencia a esta cuenta — ya con la comisión de la plataforma descontada. '
          'Normalmente se acredita en minutos; Mercado Pago confirma la transferencia y ahí '
          'queda hecha. Si el cliente no confirma, el pago se libera solo a las 72 horas.',
          style: AppTypography.body,
        ),

        const SizedBox(height: AppSpacing.lg),
        TextButton(
          onPressed: busy ? null : onUnlink,
          style: TextButton.styleFrom(foregroundColor: AppColors.alarm),
          child: const Text('Desvincular cuenta'),
        ),
      ],
    );
  }
}
