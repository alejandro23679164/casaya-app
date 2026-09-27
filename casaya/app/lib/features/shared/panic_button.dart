import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';

/// Botón de emergencia. Lo usan las dos partes: el cliente con un desconocido
/// adentro de su casa, el técnico en un domicilio que no conoce.
///
/// Dos decisiones deliberadas:
///  - No dispara al primer toque. Un pánico accidental en el bolsillo quema la
///    credibilidad del sistema, así que hay una confirmación de un paso.
///  - La confirmación es grande, con dos salidas claras: llamar a emergencias
///    directo o avisar a los contactos con la ubicación.
class PanicAction extends ConsumerWidget {
  const PanicAction({super.key, this.requestId});

  final String? requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      tooltip: 'Emergencia',
      icon: const Icon(Icons.shield_outlined, color: AppColors.alarm),
      onPressed: () => showPanicSheet(context, ref, requestId: requestId),
    );
  }
}

Future<void> showPanicSheet(BuildContext context, WidgetRef ref, {String? requestId}) {
  return showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.white,
    isDismissible: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg, AppSpacing.lg, AppSpacing.lg,
        AppSpacing.lg + MediaQuery.paddingOf(sheetContext).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('¿Necesitás ayuda ahora?', style: AppTypography.display),
          const SizedBox(height: AppSpacing.sm),
          const Text(
            'Podemos avisar a tus contactos de emergencia con tu ubicación exacta, '
            'o llamás directo al número de emergencias.',
            style: AppTypography.body,
          ),
          const SizedBox(height: AppSpacing.lg),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: AppColors.alarm),
            icon: const Icon(Icons.call),
            label: const Text('Llamar a emergencias'),
            onPressed: () => launchUrl(Uri.parse('tel:911')),
          ),
          const SizedBox(height: AppSpacing.sm),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(52),
              foregroundColor: AppColors.alarm,
              side: const BorderSide(color: AppColors.alarm),
            ),
            icon: const Icon(Icons.share_location),
            label: const Text('Avisar a mis contactos'),
            onPressed: () async {
              Navigator.of(sheetContext).pop();
              await ref.read(safetyRepositoryProvider).triggerPanic(requestId: requestId);
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    backgroundColor: AppColors.alarm,
                    content: Text('Avisamos a tus contactos y a nuestro equipo con tu ubicación.'),
                  ),
                );
              }
            },
          ),
          const SizedBox(height: AppSpacing.md),
          Center(
            child: TextButton(
              onPressed: () => Navigator.of(sheetContext).pop(),
              child: const Text('Fue sin querer, volver'),
            ),
          ),
        ],
      ),
    ),
  );
}
