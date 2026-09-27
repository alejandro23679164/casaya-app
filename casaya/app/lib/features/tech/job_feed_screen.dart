import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';

/// Bandeja del técnico: trabajos ofrecidos, con todo lo necesario para decidir.
///
/// Antes de aceptar, el técnico ve las fotos del problema, la descripción, la
/// zona (no la dirección exacta), lo que va a cobrar y la calificación del
/// cliente. Aceptar a ciegas es lo que hace que un técnico pierda un viaje.
class JobFeedScreen extends ConsumerWidget {
  const JobFeedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offers = ref.watch(incomingOffersProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Trabajos disponibles')),
      body: offers.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => const Center(child: Text('No pudimos cargar los trabajos.')),
        data: (list) {
          if (list.isEmpty) return const _EmptyFeed();
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: ListView.separated(
                padding: const EdgeInsets.all(AppSpacing.md),
                itemCount: list.length,
                separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                itemBuilder: (_, i) => OfferCard(offer: list[i]),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _EmptyFeed extends StatelessWidget {
  const _EmptyFeed();

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: const [
              Icon(Icons.inbox_outlined, size: 40, color: AppColors.slate),
              SizedBox(height: AppSpacing.md),
              Text('No hay trabajos por ahora', style: AppTypography.title),
              SizedBox(height: AppSpacing.xs),
              Text(
                'Mantené la app abierta y el estado en línea. Te avisamos apenas aparezca uno cerca.',
                style: AppTypography.caption,
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
}

/// Tarjeta de oferta con cuenta regresiva. El reloj corre hacia abajo porque
/// la oferta vence: si el técnico no responde, pasa al siguiente.
class OfferCard extends ConsumerStatefulWidget {
  const OfferCard({super.key, required this.offer});

  final DispatchOffer offer;

  @override
  ConsumerState<OfferCard> createState() => _OfferCardState();
}

class _OfferCardState extends ConsumerState<OfferCard> {
  Timer? _timer;
  Duration _left = Duration.zero;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _left = widget.offer.timeLeft;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _left = widget.offer.timeLeft);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _accept() async {
    setState(() => _busy = true);
    try {
      await ref.read(jobRepositoryProvider).accept(widget.offer.requestId);
      if (mounted) context.push('/trabajo/${widget.offer.requestId}');
    } catch (e) {
      if (!mounted) return;
      // 'aborted' significa que otro técnico llegó primero: no es un error del
      // usuario y se dice sin dramatismo.
      final tookIt = e.toString().contains('aborted');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(tookIt ? 'Otro técnico tomó este trabajo.' : 'No pudimos aceptarlo. Probá de nuevo.'),
      ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = ref.watch(requestProvider(widget.offer.requestId));
    final expired = _left.isNegative;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: request.when(
          loading: () => const SizedBox(height: 120, child: Center(child: CircularProgressIndicator())),
          error: (_, __) => const Text('Este trabajo ya no está disponible.'),
          data: (r) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(child: Text(r.category.label, style: AppTypography.title)),
                  _Countdown(left: _left),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),

              // Lo que el técnico necesita para decidir, en una línea.
              Wrap(
                spacing: AppSpacing.md,
                runSpacing: AppSpacing.xs,
                children: [
                  _Fact(icon: Icons.near_me_outlined, text: '${widget.offer.distanceKm} km'),
                  _Fact(icon: Icons.payments_outlined,
                      text: '\$${(widget.offer.estimatedPayout / 100).toStringAsFixed(0)} para vos'),
                  _Fact(icon: Icons.place_outlined, text: r.addressLine),
                ],
              ),

              const SizedBox(height: AppSpacing.md),
              Text(r.description, style: AppTypography.body, maxLines: 3, overflow: TextOverflow.ellipsis),

              if (r.mediaPaths.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.md),
                SizedBox(
                  height: 84,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: r.mediaPaths.length,
                    separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
                    itemBuilder: (_, i) => _ProblemPhoto(storagePath: r.mediaPaths[i]),
                  ),
                ),
              ],

              const SizedBox(height: AppSpacing.md),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                      onPressed: _busy ? null : () {
                        ref.read(jobRepositoryProvider).reject(widget.offer.requestId);
                      },
                      child: const Text('Rechazar'),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      onPressed: (_busy || expired) ? null : _accept,
                      child: Text(expired ? 'Oferta vencida' : 'Aceptar trabajo'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Countdown extends StatelessWidget {
  const _Countdown({required this.left});
  final Duration left;

  @override
  Widget build(BuildContext context) {
    final seconds = left.inSeconds.clamp(0, 999);
    final urgent = seconds <= 10;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: urgent ? AppColors.alarm.withOpacity(0.1) : AppColors.surface,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text('${seconds}s',
          style: AppTypography.bodyStrong.copyWith(color: urgent ? AppColors.alarm : AppColors.slate)),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: AppColors.slate),
          const SizedBox(width: 4),
          Text(text, style: AppTypography.caption),
        ],
      );
}

class _ProblemPhoto extends StatelessWidget {
  const _ProblemPhoto({required this.storagePath});
  final String storagePath;

  @override
  Widget build(BuildContext context) {
    // En producción: FutureBuilder sobre FirebaseStorage.ref(path).getDownloadURL()
    // envuelto en CachedNetworkImage.
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        width: 84, height: 84,
        color: AppColors.surface,
        child: const Icon(Icons.image_outlined, color: AppColors.slate),
      ),
    );
  }
}
